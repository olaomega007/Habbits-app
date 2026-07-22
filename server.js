const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const ss = require('simple-statistics');
const { format, subDays, subWeeks, startOfWeek, endOfWeek, eachDayOfInterval, parseISO } = require('date-fns');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'https://throughline-app.vercel.app']

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true
}));
app.use(express.json());

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Supabase client (for auth verification)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ───────────────────────────────────────────────
// AUTH MIDDLEWARE
// ───────────────────────────────────────────────
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) throw new Error('Invalid token');
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

// ───────────────────────────────────────────────
// LOGS ROUTES
// ───────────────────────────────────────────────

// Create or update a log entry
app.post('/api/logs', authenticateUser, async (req, res) => {
  const { log_date, domain, metric_type, value, note } = req.body;
  const user_id = req.user.id;

  if (!log_date || !domain || !metric_type || value === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const query = `
      INSERT INTO logs (user_id, log_date, domain, metric_type, value, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, log_date, metric_type)
      DO UPDATE SET value = $5, note = $6, updated_at = NOW()
      RETURNING *
    `;
    const result = await pool.query(query, [user_id, log_date, domain, metric_type, value, note || null]);

    // Trigger insight generation asynchronously
    generateInsights(user_id).catch(console.error);

    res.json({ success: true, log: result.rows[0] });
  } catch (err) {
    console.error('Log error:', err);
    res.status(500).json({ error: 'Failed to save log' });
  }
});

// Get logs for a date range
app.get('/api/logs', authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { start_date, end_date, domain, metric_type } = req.query;

  try {
    let query = 'SELECT * FROM logs WHERE user_id = $1';
    const params = [user_id];
    let paramCount = 1;

    if (start_date) {
      paramCount++;
      query += ` AND log_date >= $${paramCount}`;
      params.push(start_date);
    }
    if (end_date) {
      paramCount++;
      query += ` AND log_date <= $${paramCount}`;
      params.push(end_date);
    }
    if (domain) {
      paramCount++;
      query += ` AND domain = $${paramCount}`;
      params.push(domain);
    }
    if (metric_type) {
      paramCount++;
      query += ` AND metric_type = $${paramCount}`;
      params.push(metric_type);
    }

    query += ' ORDER BY log_date DESC';
    const result = await pool.query(query, params);
    res.json({ logs: result.rows });
  } catch (err) {
    console.error('Fetch logs error:', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Delete a log
app.delete('/api/logs/:id', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    await pool.query('DELETE FROM logs WHERE id = $1 AND user_id = $2', [id, user_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete log' });
  }
});

// ───────────────────────────────────────────────
// INSIGHTS ROUTES
// ───────────────────────────────────────────────

// Get all insights for user
app.get('/api/insights', authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { unread_only } = req.query;

  try {
    let query = 'SELECT * FROM insights WHERE user_id = $1';
    const params = [user_id];

    if (unread_only === 'true') {
      query += ' AND is_read = FALSE';
    }

    query += ' ORDER BY generated_at DESC';
    const result = await pool.query(query, params);
    res.json({ insights: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch insights' });
  }
});

// Mark insight as read
app.patch('/api/insights/:id/read', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    await pool.query(
      'UPDATE insights SET is_read = TRUE WHERE id = $1 AND user_id = $2',
      [id, user_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update insight' });
  }
});

// ───────────────────────────────────────────────
// DASHBOARD / SUMMARY ROUTES
// ───────────────────────────────────────────────

// Get dashboard summary
app.get('/api/dashboard', authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  try {
    // Total logs count
    const logsCount = await pool.query(
      'SELECT COUNT(*) FROM logs WHERE user_id = $1',
      [user_id]
    );

    // Days with data
    const daysWithData = await pool.query(
      'SELECT COUNT(DISTINCT log_date) FROM logs WHERE user_id = $1',
      [user_id]
    );

    // Latest insight
    const latestInsight = await pool.query(
      'SELECT * FROM insights WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 1',
      [user_id]
    );

    // Unread insights count
    const unreadCount = await pool.query(
      'SELECT COUNT(*) FROM insights WHERE user_id = $1 AND is_read = FALSE',
      [user_id]
    );

    // Recent averages (last 7 days)
    const recentAverages = await pool.query(`
      SELECT metric_type, AVG(value) as avg_value, COUNT(*) as count
      FROM logs 
      WHERE user_id = $1 AND log_date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY metric_type
    `, [user_id]);

    res.json({
      total_logs: parseInt(logsCount.rows[0].count),
      days_with_data: parseInt(daysWithData.rows[0].count),
      latest_insight: latestInsight.rows[0] || null,
      unread_insights: parseInt(unreadCount.rows[0].count),
      recent_averages: recentAverages.rows
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ───────────────────────────────────────────────
// CORRELATION ENGINE (THE CORE IP)
// ───────────────────────────────────────────────

async function generateInsights(user_id) {
  try {
    // Get all user logs, ordered by date
    const result = await pool.query(
      'SELECT * FROM logs WHERE user_id = $1 ORDER BY log_date ASC',
      [user_id]
    );

    const logs = result.rows;
    if (logs.length < 14) return; // Need at least 2 weeks of data

    // Group by metric_type
    const byMetric = {};
    logs.forEach(log => {
      if (!byMetric[log.metric_type]) byMetric[log.metric_type] = [];
      byMetric[log.metric_type].push({ date: log.log_date, value: parseFloat(log.value) });
    });

    const insights = [];
    const metricPairs = [
      ['sleep_hours', 'mood_rating'],
      ['spend_total', 'mood_rating'],
      ['spend_total', 'sleep_hours'],
      ['income', 'mood_rating'],
      ['social_satisfaction', 'mood_rating'],
      ['contact_frequency', 'mood_rating']
    ];

    for (const [metricA, metricB] of metricPairs) {
      if (!byMetric[metricA] || !byMetric[metricB]) continue;

      // Align by date (only dates where both metrics exist)
      const aligned = alignByDate(byMetric[metricA], byMetric[metricB]);
      if (aligned.length < 7) continue; // Need at least 7 paired observations

      const valuesA = aligned.map(d => d.valueA);
      const valuesB = aligned.map(d => d.valueB);

      const correlation = ss.sampleCorrelation(valuesA, valuesB);
      if (isNaN(correlation)) continue;

      // Only surface meaningful correlations
      if (Math.abs(correlation) < 0.3) continue;

      const insight = buildInsightText(metricA, metricB, correlation, aligned.length, valuesA, valuesB);
      if (insight) {
        insights.push({
          user_id,
          insight_text: insight.text,
          confidence_level: insight.confidence,
          domains_involved: insight.domains,
          metric_types_involved: [metricA, metricB],
          correlation_value: correlation
        });
      }
    }

    // Save insights (avoid duplicates - simple approach: delete old, insert new for now)
    // In production, we'd be smarter about this
    if (insights.length > 0) {
      await pool.query('DELETE FROM insights WHERE user_id = $1', [user_id]);

      for (const insight of insights) {
        await pool.query(`
          INSERT INTO insights (user_id, insight_text, confidence_level, domains_involved, metric_types_involved, correlation_value)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [insight.user_id, insight.insight_text, insight.confidence_level, 
            insight.domains_involved, insight.metric_types_involved, insight.correlation_value]);
      }
    }
  } catch (err) {
    console.error('Insight generation error:', err);
  }
}

function alignByDate(seriesA, seriesB) {
  const mapB = {};
  seriesB.forEach(item => { mapB[item.date] = item.value; });

  return seriesA
    .filter(item => mapB[item.date] !== undefined)
    .map(item => ({ date: item.date, valueA: item.value, valueB: mapB[item.date] }));
}

function buildInsightText(metricA, metricB, correlation, n, valuesA, valuesB) {
  const domainMap = {
    'spend_total': 'finance', 'income': 'finance',
    'sleep_hours': 'mood_sleep', 'mood_rating': 'mood_sleep',
    'social_satisfaction': 'relationships', 'contact_frequency': 'relationships'
  };

  const labelMap = {
    'spend_total': 'spending',
    'income': 'income',
    'sleep_hours': 'sleep',
    'mood_rating': 'mood',
    'social_satisfaction': 'relationship satisfaction',
    'contact_frequency': 'social contact'
  };

  const domains = [...new Set([domainMap[metricA], domainMap[metricB]])];
  const labelA = labelMap[metricA];
  const labelB = labelMap[metricB];

  // Determine confidence
  let confidence = 'low';
  if (n >= 14) confidence = 'medium';
  if (n >= 30) confidence = 'high';

  // Calculate averages for context
  const avgA = ss.mean(valuesA);
  const avgB = ss.mean(valuesB);

  let text = '';
  const strength = Math.abs(correlation) > 0.6 ? 'strong' : 'moderate';
  const direction = correlation > 0 ? 'higher' : 'lower';
  const inverseDirection = correlation > 0 ? 'lower' : 'higher';

  if (metricA === 'sleep_hours' && metricB === 'mood_rating') {
    if (correlation > 0) {
      text = `In your logged data, days with more sleep were associated with better mood ratings. This is a ${strength} positive relationship based on ${n} days of data.`;
    } else {
      text = `In your logged data, days with more sleep were associated with lower mood ratings — an unexpected pattern worth watching. Based on ${n} days of data.`;
    }
  } else if (metricA === 'spend_total' && metricB === 'mood_rating') {
    if (correlation < 0) {
      text = `In your logged data, days with higher spending were associated with lower mood ratings. This ${strength} negative relationship is based on ${n} days of data.`;
    } else {
      text = `In your logged data, higher spending and better mood tended to occur together. This ${strength} relationship is based on ${n} days of data.`;
    }
  } else if (metricA === 'spend_total' && metricB === 'sleep_hours') {
    text = `In your logged data, ${direction} spending days were associated with ${direction} sleep. This ${strength} relationship is based on ${n} days of data.`;
  } else if (metricA === 'income' && metricB === 'mood_rating') {
    text = `In your logged data, higher income days were associated with ${direction} mood ratings. This ${strength} relationship is based on ${n} days of data.`;
  } else if (metricA === 'social_satisfaction' && metricB === 'mood_rating') {
    text = `In your logged data, higher relationship satisfaction was associated with ${direction} mood. This ${strength} relationship is based on ${n} days of data.`;
  } else if (metricA === 'contact_frequency' && metricB === 'mood_rating') {
    text = `In your logged data, more social contact was associated with ${direction} mood ratings. This ${strength} relationship is based on ${n} days of data.`;
  } else {
    text = `In your logged data, ${labelA} and ${labelB} show a ${strength} ${correlation > 0 ? 'positive' : 'negative'} relationship (r=${correlation.toFixed(2)}) based on ${n} data points.`;
  }

  return { text, confidence, domains };
}

// ───────────────────────────────────────────────
// SUBSCRIPTION ROUTES (Stripe)
// ───────────────────────────────────────────────

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Create checkout session
app.post('/api/subscription/checkout', authenticateUser, async (req, res) => {
  const user_id = req.user.id;
  const { price_id } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: price_id || process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${req.headers.origin}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/subscription/cancel`,
      client_reference_id: user_id,
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Webhook for subscription events
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const user_id = session.client_reference_id;

    if (user_id) {
      await pool.query(
        "UPDATE profiles SET subscription_status = 'active' WHERE id = $1",
        [user_id]
      );
    }
  }

  res.json({ received: true });
});

// Get subscription status
app.get('/api/subscription/status', authenticateUser, async (req, res) => {
  const user_id = req.user.id;

  try {
    const result = await pool.query(
      'SELECT subscription_status, trial_ends_at FROM profiles WHERE id = $1',
      [user_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// ───────────────────────────────────────────────
// HEALTH CHECK
// ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ───────────────────────────────────────────────
// START SERVER
// ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Throughline API running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
