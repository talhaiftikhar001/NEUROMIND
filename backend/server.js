const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const connectDB = require('./config/db');

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (CSS, JS, images, videos)
app.use('/css', express.static(path.join(__dirname, '../css')));
app.use('/js', express.static(path.join(__dirname, '../js')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));
app.use(express.static(path.join(__dirname, '..'))); // Serve root files like videos

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/doctors', require('./routes/doctors'));

// Serve HTML pages
app.get('/', (req, res) => {
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/register.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/dashboard.html'));
});

app.get('/patient-records', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/patient-records.html'));
});

app.get('/add-patient', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/add-patient.html'));
});

app.get('/edit-patient', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/edit-patient.html'));
});

app.get('/classification', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/classification.html'));
});

app.get('/results-classification', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/results-classification.html'));
});

app.get('/results-autoencoder', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/results-autoencoder.html'));
});

app.get('/chatbot', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/chatbot.html'));
});

app.get('/eeg-live', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/eeg-live.html'));
});

// Proxy route — fetches inference.html from Pi and returns it to browser
// Avoids ERR_CONNECTION_TIMED_OUT caused by browser directly hitting Flask
app.get('/pi-plot', async (req, res) => {
    const ip = req.query.ip;
    if (!ip) return res.status(400).send('Missing ip parameter');
    const url = `http://${ip}:5001/output/inference.html`;
    try {
        const response = await fetch(url);
        if (!response.ok) return res.status(response.status).send(`Pi returned ${response.status}`);
        const html = await response.text();
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (err) {
        res.status(502).send(`Could not reach Pi: ${err.message}`);
    }
});

// Proxy: start EEG recording on Pi (runs main.py)
app.post('/pi-eeg-start', async (req, res) => {
    const ip = req.query.ip;
    if (!ip) return res.status(400).json({ success: false, error: 'Missing ip' });
    try {
        const response = await fetch(`http://${ip}:5001/eeg/start-recording`, { method: 'POST' });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(502).json({ success: false, error: err.message });
    }
});

// Proxy: poll EEG recording status
app.get('/pi-eeg-status', async (req, res) => {
    const ip = req.query.ip;
    if (!ip) return res.status(400).json({ success: false, error: 'Missing ip' });
    try {
        const response = await fetch(`http://${ip}:5001/eeg/recording-status`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(502).json({ success: false, error: err.message });
    }
});

// Proxy: get EDF channel data as JSON
app.get('/pi-eeg-data', async (req, res) => {
    const ip = req.query.ip;
    if (!ip) return res.status(400).json({ success: false, error: 'Missing ip' });
    try {
        const response = await fetch(`http://${ip}:5001/eeg/get-data`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(502).json({ success: false, error: err.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Something went wrong!', error: err.message });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`   NeuroMind Server is Running!`);
    console.log(`========================================`);
    console.log(`   Open: http://localhost:${PORT}`);
    console.log(`   API:  http://localhost:${PORT}/api`);
    console.log(`========================================\n`);
});
