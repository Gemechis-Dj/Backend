const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Get subscription plans
router.get('/plans', async (req, res) => {
    try {
        const { data: plans, error } = await supabase
            .from('subscription_plans').select('id, name, tier, price_monthly, price_yearly, features, limits_json')
            .eq('is_active', true).order('price_monthly', { ascending: true });
        if (error) throw error;

        const formattedPlans = (plans || []).map(plan => ({
            ...plan,
            features: JSON.parse(plan.features),
            limits: JSON.parse(plan.limits_json)
        }));

        res.json({ plans: formattedPlans });
    } catch (error) {
        console.error('Get plans error:', error);
        res.status(500).json({ error: 'Failed to get subscription plans' });
    }
});

// Create Stripe checkout session
router.post('/create-checkout-session', authenticateToken, async (req, res) => {
    try {
        const { tier, billingPeriod = 'monthly' } = req.body;
        if (!['monthly', 'yearly'].includes(billingPeriod))
            return res.status(400).json({ error: 'Invalid billing period' });

        const { data: plans } = await supabase.from('subscription_plans').select('*')
            .eq('tier', tier).eq('is_active', true).limit(1);
        if (!plans || plans.length === 0) return res.status(404).json({ error: 'Plan not found' });

        const plan = plans[0];
        const price = billingPeriod === 'monthly' ? plan.price_monthly : plan.price_yearly;

        let customerId = req.user.stripe_customer_id;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: req.user.email, name: req.user.name,
                metadata: { userId: req.user.id.toString() }
            });
            customerId = customer.id;
            await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', req.user.id);
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `JobPilot AI ${plan.name}`,
                        description: `${billingPeriod === 'monthly' ? 'Monthly' : 'Yearly'} subscription`
                    },
                    unit_amount: Math.round(price * 100),
                    recurring: { interval: billingPeriod === 'monthly' ? 'month' : 'year' }
                },
                quantity: 1
            }],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/pricing`,
            metadata: { userId: req.user.id.toString(), tier, billingPeriod }
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('Create checkout session error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Create portal session
router.post('/create-portal-session', authenticateToken, async (req, res) => {
    try {
        if (!req.user.stripe_customer_id)
            return res.status(400).json({ error: 'No active subscription found' });

        const session = await stripe.billingPortal.sessions.create({
            customer: req.user.stripe_customer_id,
            return_url: `${process.env.FRONTEND_URL}/dashboard`
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Create portal session error:', error);
        res.status(500).json({ error: 'Failed to create portal session' });
    }
});

// Stripe webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        await supabase.from('webhook_events').insert({
            event_id: event.id, event_type: event.type, payload: JSON.stringify(event.data.object)
        });

        switch (event.type) {
            case 'checkout.session.completed': await handleCheckoutComplete(event.data.object); break;
            case 'customer.subscription.created':
            case 'customer.subscription.updated': await handleSubscriptionUpdate(event.data.object); break;
            case 'customer.subscription.deleted': await handleSubscriptionDeleted(event.data.object); break;
            case 'invoice.payment_succeeded': await handlePaymentSucceeded(event.data.object); break;
            case 'invoice.payment_failed': await handlePaymentFailed(event.data.object); break;
            default: console.log(`Unhandled event type: ${event.type}`);
        }

        await supabase.from('webhook_events').update({ processed: true, processed_at: new Date().toISOString() })
            .eq('event_id', event.id);

        res.json({ received: true });
    } catch (error) {
        console.error('Webhook handler error:', error);
        await supabase.from('webhook_events').update({ error_message: error.message }).eq('event_id', event.id);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

async function handleCheckoutComplete(session) {
    const userId = parseInt(session.metadata.userId);
    const tier = session.metadata.tier;
    await supabase.from('users').update({
        subscription_tier: tier, subscription_status: 'active',
        stripe_customer_id: session.customer, stripe_subscription_id: session.subscription,
        subscription_start_date: new Date().toISOString()
    }).eq('id', userId);
    await supabase.from('activity_log').insert({
        user_id: userId, activity_type: 'subscription_created', description: `Subscribed to ${tier} plan`
    });
}

async function handleSubscriptionUpdate(subscription) {
    const { data: users } = await supabase.from('users').select('id')
        .eq('stripe_subscription_id', subscription.id).limit(1);
    if (!users || users.length === 0) return;
    await supabase.from('users').update({
        subscription_status: subscription.status === 'active' ? 'active' : subscription.status,
        subscription_end_date: new Date(subscription.current_period_end * 1000).toISOString()
    }).eq('id', users[0].id);
}

async function handleSubscriptionDeleted(subscription) {
    const { data: users } = await supabase.from('users').select('id')
        .eq('stripe_subscription_id', subscription.id).limit(1);
    if (!users || users.length === 0) return;
    await supabase.from('users').update({
        subscription_tier: 'free', subscription_status: 'cancelled', stripe_subscription_id: null
    }).eq('id', users[0].id);
    await supabase.from('activity_log').insert({
        user_id: users[0].id, activity_type: 'subscription_cancelled', description: 'Subscription cancelled'
    });
}

async function handlePaymentSucceeded(invoice) {
    const { data: users } = await supabase.from('users').select('id')
        .eq('stripe_customer_id', invoice.customer).limit(1);
    if (!users || users.length === 0) return;
    await supabase.from('payment_transactions').insert({
        user_id: users[0].id, stripe_payment_id: invoice.payment_intent,
        stripe_invoice_id: invoice.id, amount: invoice.amount_paid / 100,
        currency: invoice.currency, status: 'succeeded', description: 'Subscription payment'
    });
}

async function handlePaymentFailed(invoice) {
    const { data: users } = await supabase.from('users').select('id')
        .eq('stripe_customer_id', invoice.customer).limit(1);
    if (!users || users.length === 0) return;
    await supabase.from('users').update({ subscription_status: 'past_due' }).eq('id', users[0].id);
    await supabase.from('activity_log').insert({
        user_id: users[0].id, activity_type: 'payment_failed', description: 'Subscription payment failed'
    });
}

module.exports = router;
