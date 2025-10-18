// Test sync
/**
 * Political Trends Tracker - FREE VERSION
 * Scrapes us.trend-calendar.com instead of using expensive X API
 * Tracks trending duration and builds timeline
 */

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const app = express();
const PORT = process.env.PORT || 3000;
const TREND_URL = 'https://us.trend-calendar.com';
const DATA_FILE = 'trends_timeline.json';
const ALERTS_FILE = 'alerts_log.json';
const CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// POLITICAL KEYWORD DETECTION
// ==========================================
const POLITICAL_KEYWORDS = [
    'election', 'vote', 'voting', 'ballot', 'poll',
    'congress', 'senate', 'house', 'representative',
    'president', 'biden', 'trump', 'potus', 'white house',
    'governor', 'mayor', 'legislation', 'bill',
    'supreme court', 'scotus', 'justice', 'court',
    'policy', 'executive order', 'veto',
    'democrat', 'republican', 'gop', 'dnc', 'rnc',
    'campaign', 'debate', 'primary', 'caucus',
    'impeach', 'filibuster', 'partisan',
    'constitutional', 'amendment', 'federal',
    'government', 'capitol', 'washington',
    'senate', 'congress', 'hearing', 'testimony',
    'state department', 'secretary', 'cabinet',
    'nato', 'foreign policy', 'sanctions',
    'budget', 'spending', 'deficit', 'fiscal',
    'immigration', 'border', 'visa', 'asylum'
];

function isPolitical(topic) {
    const lowerTopic = topic.toLowerCase();
    return POLITICAL_KEYWORDS.some(keyword => lowerTopic.includes(keyword));
}

// ==========================================
// WEB SCRAPING FUNCTIONS
// ==========================================
async function scrapeTrendCalendar() {
    try {
        console.log('Fetching trends from Trend Calendar...');

        const response = await axios.get(TREND_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const trends = [];

        // Find the X (Twitter) trending section
        const twitterSection = $('h2:contains("X (Twitter)")').parent();

        // Extract trends - they appear as numbered list items
        twitterSection.find('p, li, div').each((i, elem) => {
            const text = $(elem).text().trim();

            // Match pattern like "2.Duke of York" or "16.Karoline Leavitt"
            const match = text.match(/^(\d+)\.\s*(.+)$/);

            if (match) {
                const rank = parseInt(match[1]);
                const topic = match[2].trim();

                // Skip empty or very short topics
                if (topic && topic.length > 1) {
                    trends.push({
                        rank,
                        topic,
                        source: 'X (Twitter)',
                        scraped_at: new Date().toISOString()
                    });
                }
            }
        });

        console.log(`✅ Scraped ${trends.length} trends from Trend Calendar`);
        return trends;

    } catch (error) {
        console.error('❌ Error scraping Trend Calendar:', error.message);
        return [];
    }
}

// ==========================================
// TIMELINE TRACKING
// ==========================================
async function loadTimeline() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function saveTimeline(timeline) {
    await fs.writeFile(DATA_FILE, JSON.stringify(timeline, null, 2));
}

async function loadAlerts() {
    try {
        const data = await fs.readFile(ALERTS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function saveAlerts(alerts) {
    await fs.writeFile(ALERTS_FILE, JSON.stringify(alerts, null, 2));
}

function calculateDuration(firstSeen) {
    const start = new Date(firstSeen);
    const now = new Date();
    return Math.floor((now - start) / 60000); // minutes
}

function calculateSentiment(topic) {
    // Simple sentiment based on keywords
    const positive = ['win', 'victory', 'success', 'improve', 'growth', 'peace', 'unity'];
    const negative = ['scandal', 'crisis', 'fail', 'attack', 'war', 'crime', 'death'];

    const lower = topic.toLowerCase();
    let score = 0;

    positive.forEach(word => {
        if (lower.includes(word)) score += 0.3;
    });

    negative.forEach(word => {
        if (lower.includes(word)) score -= 0.3;
    });

    // Clamp between -1 and 1
    score = Math.max(-1, Math.min(1, score));

    let label;
    if (score > 0.3) label = 'Positive';
    else if (score < -0.3) label = 'Negative';
    else if (score > 0.1) label = 'Slightly Positive';
    else if (score < -0.1) label = 'Slightly Negative';
    else label = 'Neutral';

    return { score, label };
}

function categorizeTrend(topic) {
    const lower = topic.toLowerCase();

    if (lower.match(/election|vote|ballot|poll|campaign/)) return 'Elections';
    if (lower.match(/congress|senate|house|representative|filibuster/)) return 'Congress';
    if (lower.match(/president|white house|potus|executive order/)) return 'White House';
    if (lower.match(/supreme court|scotus|justice|ruling|court/)) return 'Judicial';
    if (lower.match(/governor|state|local|mayor/)) return 'State & Local';
    if (lower.match(/foreign|nato|sanctions|diplomat|embassy/)) return 'Foreign Policy';
    if (lower.match(/budget|spending|deficit|fiscal|economy/)) return 'Economy';

    return 'General Politics';
}

async function updateTimeline() {
    const scrapedTrends = await scrapeTrendCalendar();
    const timeline = await loadTimeline();
    const now = new Date().toISOString();

    // Filter for political trends only
    const politicalTrends = scrapedTrends.filter(t => isPolitical(t.topic));

    console.log(`🗳️  Found ${politicalTrends.length} political trends out of ${scrapedTrends.length} total`);

    const newTrends = [];
    const currentTopics = new Set();

    for (const scrapedTrend of politicalTrends) {
        currentTopics.add(scrapedTrend.topic);

        // Find existing entry
        let existing = timeline.find(t => 
            t.topic.toLowerCase() === scrapedTrend.topic.toLowerCase()
        );

        if (existing) {
            // Update existing trend
            existing.last_seen = now;
            existing.duration_minutes = calculateDuration(existing.first_seen);
            existing.check_count++;
            existing.current_rank = scrapedTrend.rank;
            existing.is_active = true;

            // Update lowest rank if this is better
            if (scrapedTrend.rank < existing.lowest_rank) {
                existing.lowest_rank = scrapedTrend.rank;
            }
        } else {
            // New trend detected!
            const sentiment = calculateSentiment(scrapedTrend.topic);
            const category = categorizeTrend(scrapedTrend.topic);

            const newTrend = {
                id: Date.now() + Math.random(),
                topic: scrapedTrend.topic,
                category,
                first_seen: now,
                last_seen: now,
                duration_minutes: 0,
                check_count: 1,
                current_rank: scrapedTrend.rank,
                lowest_rank: scrapedTrend.rank,
                highest_rank: scrapedTrend.rank,
                sentiment: sentiment.score,
                sentiment_label: sentiment.label,
                is_active: true,
                source: 'Trend Calendar'
            };

            timeline.push(newTrend);
            newTrends.push(newTrend);

            console.log(`🆕 NEW POLITICAL TREND: ${newTrend.topic} (${category})`);
        }
    }

    // Mark trends that disappeared as inactive
    timeline.forEach(trend => {
        if (!currentTopics.has(trend.topic)) {
            if (trend.is_active) {
                console.log(`📉 Trend ended: ${trend.topic} (lasted ${trend.duration_minutes} minutes)`);
            }
            trend.is_active = false;
        }
    });

    await saveTimeline(timeline);

    // Send alerts for new political trends
    for (const trend of newTrends) {
        await checkAndSendAlert(trend);
    }

    return { total: timeline.length, new: newTrends.length, active: politicalTrends.length };
}

// ==========================================
// EMAIL ALERTS
// ==========================================
let userSettings = {
    email: 'doterra2livewell@gmail.com',
    minRank: 50, // Alert if trend is in top 50
    frequency: 'Immediate',
    enabledCategories: ['Elections', 'Congress', 'White House', 'Judicial', 'Foreign Policy']
};

async function checkAndSendAlert(trend) {
    // Check if trend meets alert criteria
    if (trend.current_rank > userSettings.minRank) {
        return;
    }

    if (!userSettings.enabledCategories.includes(trend.category)) {
        return;
    }

    await sendEmailAlert(trend);
}

async function sendEmailAlert(trend) {
    // Check if email is configured
    if (!process.env.OAUTH_CLIENT_ID) {
        console.log('⚠️  Email not configured. Alert would be sent for:', trend.topic);

        const alerts = await loadAlerts();
        alerts.push({
            timestamp: new Date().toISOString(),
            topic: trend.topic,
            category: trend.category,
            rank: trend.current_rank,
            status: 'Would Send (Email Not Configured)'
        });
        await saveAlerts(alerts);
        return;
    }

    try {
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: {
                type: 'OAuth2',
                user: process.env.EMAIL_HOST,
                clientId: process.env.OAUTH_CLIENT_ID,
                clientSecret: process.env.OAUTH_CLIENT_SECRET,
                refreshToken: process.env.OAUTH_REFRESH_TOKEN
            }
        });

        const emailContent = {
            from: process.env.EMAIL_HOST,
            to: userSettings.email,
            subject: `🚨 New Political Trend: ${trend.topic} (Rank #${trend.current_rank})`,
            html: `
                <h2>🗳️ New Political Trend Detected</h2>
                <hr>
                <p><strong>Topic:</strong> ${trend.topic}</p>
                <p><strong>Category:</strong> ${trend.category}</p>
                <p><strong>Current Rank:</strong> #${trend.current_rank}</p>
                <p><strong>First Detected:</strong> ${new Date(trend.first_seen).toLocaleString()}</p>
                <p><strong>Sentiment:</strong> ${trend.sentiment_label} (${trend.sentiment.toFixed(2)})</p>
                <hr>
                <p><em>This trend is currently active on X (Twitter) in the United States.</em></p>
                <p><small>Source: Trend Calendar US | Political Trends Tracker</small></p>
            `
        };

        const info = await transporter.sendMail(emailContent);
        console.log('✅ Email alert sent:', info.messageId);

        const alerts = await loadAlerts();
        alerts.push({
            timestamp: new Date().toISOString(),
            topic: trend.topic,
            category: trend.category,
            rank: trend.current_rank,
            status: 'Sent',
            messageId: info.messageId
        });
        await saveAlerts(alerts);

    } catch (error) {
        console.error('❌ Error sending email:', error.message);
    }
}

// ==========================================
// API ENDPOINTS
// ==========================================

// Get all trends
app.get('/api/trends', async (req, res) => {
    try {
        const { category, active, sortBy } = req.query;
        let timeline = await loadTimeline();

        // Filter by category
        if (category && category !== 'All') {
            timeline = timeline.filter(t => t.category === category);
        }

        // Filter by active status
        if (active === 'true') {
            timeline = timeline.filter(t => t.is_active);
        }

        // Sort
        if (sortBy === 'duration') {
            timeline.sort((a, b) => b.duration_minutes - a.duration_minutes);
        } else if (sortBy === 'rank') {
            timeline.sort((a, b) => a.current_rank - b.current_rank);
        } else {
            timeline.sort((a, b) => new Date(b.first_seen) - new Date(a.first_seen));
        }

        res.json(timeline);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get single trend
app.get('/api/trends/:id', async (req, res) => {
    try {
        const timeline = await loadTimeline();
        const trend = timeline.find(t => t.id == req.params.id);

        if (trend) {
            res.json(trend);
        } else {
            res.status(404).json({ error: 'Trend not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manual trend update (force scrape now)
app.post('/api/trends/update', async (req, res) => {
    try {
        const result = await updateTimeline();
        res.json({
            success: true,
            message: 'Timeline updated',
            stats: result
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get alerts log
app.get('/api/alerts', async (req, res) => {
    try {
        const alerts = await loadAlerts();
        res.json(alerts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update settings
app.put('/api/settings', async (req, res) => {
    userSettings = { ...userSettings, ...req.body };
    res.json(userSettings);
});

// Get settings
app.get('/api/settings', (req, res) => {
    res.json(userSettings);
});

// Get statistics
app.get('/api/stats', async (req, res) => {
    try {
        const timeline = await loadTimeline();
        const alerts = await loadAlerts();

        const stats = {
            total_trends: timeline.length,
            active_trends: timeline.filter(t => t.is_active).length,
            inactive_trends: timeline.filter(t => !t.is_active).length,
            total_alerts: alerts.length,
            categories: {},
            average_duration: 0,
            longest_trend: null
        };

        // Calculate category breakdown
        timeline.forEach(t => {
            stats.categories[t.category] = (stats.categories[t.category] || 0) + 1;
        });

        // Calculate average duration (active trends only)
        const activeTrends = timeline.filter(t => t.is_active);
        if (activeTrends.length > 0) {
            stats.average_duration = Math.round(
                activeTrends.reduce((sum, t) => sum + t.duration_minutes, 0) / activeTrends.length
            );
        }

        // Find longest-lasting trend
        const sorted = [...timeline].sort((a, b) => b.duration_minutes - a.duration_minutes);
        if (sorted.length > 0) {
            stats.longest_trend = {
                topic: sorted[0].topic,
                duration: sorted[0].duration_minutes
            };
        }

        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Export data
app.get('/api/export', async (req, res) => {
    try {
        const timeline = await loadTimeline();
        const alerts = await loadAlerts();

        res.json({
            trends: timeline,
            alerts,
            settings: userSettings,
            exported_at: new Date().toISOString(),
            source: 'Trend Calendar US (us.trend-calendar.com)'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// SCHEDULED UPDATES
// ==========================================
async function scheduledUpdate() {
    console.log('\n🔄 Running scheduled trend update...');
    try {
        const result = await updateTimeline();
        console.log(`✅ Update complete: ${result.active} active, ${result.new} new, ${result.total} total tracked`);
    } catch (error) {
        console.error('❌ Scheduled update failed:', error);
    }
}

// Run every 15 minutes
setInterval(scheduledUpdate, CHECK_INTERVAL);

// ==========================================
// SERVER STARTUP
// ==========================================
app.listen(PORT, async () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log('🗳️  POLITICAL TRENDS TRACKER - FREE VERSION');
    console.log(`${'='.repeat(60)}`);
    console.log(`Server running on port ${PORT}`);
    console.log(`Data source: ${TREND_URL}`);
    console.log(`Update interval: Every 15 minutes`);
    console.log(`Alert email: ${userSettings.email}`);
    console.log(`${'='.repeat(60)}\n`);

    // Initial update
    console.log('🚀 Running initial trend scrape...');
    await scheduledUpdate();

    console.log('\n✅ Server ready! Dashboard available at http://localhost:' + PORT);
});

module.exports = app;
