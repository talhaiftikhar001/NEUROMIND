// EEG Live - Real-time Signal Visualization
// Connects to Raspberry Pi via WebSocket for Cyton board data

const EEGLive = {
    // Configuration
    config: {
        wsUrl: null,
        sampleRate: 250,
        channels: 8,
        timeWindow: 10, // seconds
        maxDataPoints: 2500, // 10 seconds * 250 Hz
        connected: false,
        streaming: false,
        recording: false
    },

    // WebSocket connection
    ws: null,

    // Chart instances
    charts: [],

    // Data buffers for each channel
    dataBuffers: [],

    // Recording data
    recordingData: [],
    recordingStartTime: null,
    recordingTimer: null,

    // Data point counter
    totalDataPoints: 0,

    // Initialize
    init() {
        this.initDataBuffers();
        this.initCharts();
        this.setupEventListeners();
        this.checkPiConnection();
    },

    // Initialize data buffers
    initDataBuffers() {
        for (let i = 0; i < this.config.channels; i++) {
            this.dataBuffers[i] = [];
        }
    },

    // Initialize Chart.js charts for all channels
    initCharts() {
        const chartColors = [
            '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
            '#06b6d4', '#14b8a6', '#22c55e', '#84cc16'
        ];

        for (let i = 1; i <= this.config.channels; i++) {
            const ctx = document.getElementById(`chart${i}`);
            if (!ctx) continue;

            const chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        borderColor: chartColors[i - 1],
                        borderWidth: 1.5,
                        fill: false,
                        pointRadius: 0,
                        tension: 0.1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        x: {
                            display: false
                        },
                        y: {
                            display: true,
                            grid: {
                                color: 'rgba(139, 92, 246, 0.1)'
                            },
                            ticks: {
                                display: false
                            }
                        }
                    }
                }
            });

            this.charts.push(chart);
        }
    },

    // Setup event listeners
    setupEventListeners() {
        // Time window change
        const timeWindowSelect = document.getElementById('timeWindow');
        if (timeWindowSelect) {
            timeWindowSelect.addEventListener('change', (e) => {
                this.config.timeWindow = parseInt(e.target.value);
                this.config.maxDataPoints = this.config.timeWindow * this.config.sampleRate;
                this.clearBuffers();
            });
        }

        // Display mode change
        const displayModeSelect = document.getElementById('displayMode');
        if (displayModeSelect) {
            displayModeSelect.addEventListener('change', (e) => {
                this.updateDisplayMode(e.target.value);
            });
        }
    },

    // Check Pi connection status
    async checkPiConnection() {
        const piStatusInfo = document.getElementById('piStatusInfo');

        // Wait for PiConnect to initialize
        setTimeout(async () => {
            if (typeof PiConnect !== 'undefined' && PiConnect.config.ip) {
                const ip = PiConnect.config.ip;
                const port = PiConnect.config.port || '5001';

                try {
                    const response = await fetch(`http://${ip}:${port}/health`, {
                        method: 'GET',
                        signal: AbortSignal.timeout(5000)
                    });

                    if (response.ok) {
                        piStatusInfo.textContent = `Connected (${ip})`;
                        piStatusInfo.style.color = '#22c55e';
                        this.config.wsUrl = `ws://${ip}:${port}/eeg-stream`;
                    } else {
                        piStatusInfo.textContent = 'Pi offline';
                        piStatusInfo.style.color = '#ef4444';
                    }
                } catch (error) {
                    piStatusInfo.textContent = 'Not connected';
                    piStatusInfo.style.color = '#f59e0b';
                }
            } else {
                piStatusInfo.textContent = 'Configure Pi connection';
                piStatusInfo.style.color = '#6b7280';
            }
        }, 1500);
    },

    // Connect WebSocket
    connectWebSocket() {
        if (!this.config.wsUrl) {
            // Try to get from PiConnect
            if (typeof PiConnect !== 'undefined' && PiConnect.config.ip) {
                const ip = PiConnect.config.ip;
                const port = PiConnect.config.port || '5001';
                this.config.wsUrl = `ws://${ip}:${port}/eeg-stream`;
            } else {
                this.showError('Please connect to Raspberry Pi first');
                return false;
            }
        }

        this.updateConnectionStatus('connecting');

        try {
            this.ws = new WebSocket(this.config.wsUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.config.connected = true;
                this.updateConnectionStatus('connected');
            };

            this.ws.onmessage = (event) => {
                this.handleData(event.data);
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.showError('Connection error. Check Pi and Cyton board.');
            };

            this.ws.onclose = () => {
                console.log('WebSocket closed');
                this.config.connected = false;
                this.config.streaming = false;
                this.updateConnectionStatus('disconnected');
                this.updateButtonStates();
            };

            return true;
        } catch (error) {
            console.error('Failed to connect:', error);
            this.showError('Failed to establish WebSocket connection');
            return false;
        }
    },

    // Handle incoming data
    handleData(rawData) {
        try {
            const data = JSON.parse(rawData);

            // Expected format: { channels: [ch1, ch2, ..., ch8], timestamp: ms }
            if (data.channels && Array.isArray(data.channels)) {
                for (let i = 0; i < this.config.channels; i++) {
                    const value = data.channels[i] || 0;

                    // Add to buffer
                    this.dataBuffers[i].push(value);

                    // Trim buffer if exceeds max
                    if (this.dataBuffers[i].length > this.config.maxDataPoints) {
                        this.dataBuffers[i].shift();
                    }

                    // Update value display
                    const valueEl = document.getElementById(`ch${i + 1}Value`);
                    if (valueEl) {
                        valueEl.textContent = `${value.toFixed(2)} uV`;
                    }
                }

                // Update charts
                this.updateCharts();

                // Update data points counter
                this.totalDataPoints++;
                const dataPointsEl = document.getElementById('dataPoints');
                if (dataPointsEl) {
                    dataPointsEl.textContent = this.totalDataPoints.toLocaleString();
                }

                // Store recording data
                if (this.config.recording) {
                    this.recordingData.push({
                        timestamp: Date.now(),
                        channels: [...data.channels]
                    });
                }
            }
        } catch (error) {
            console.error('Error parsing data:', error);
        }
    },

    // Update all charts
    updateCharts() {
        for (let i = 0; i < this.config.channels; i++) {
            if (this.charts[i]) {
                this.charts[i].data.datasets[0].data = [...this.dataBuffers[i]];
                this.charts[i].data.labels = this.dataBuffers[i].map((_, idx) => idx);
                this.charts[i].update('none');
            }
        }
    },

    // Clear data buffers
    clearBuffers() {
        for (let i = 0; i < this.config.channels; i++) {
            this.dataBuffers[i] = [];
        }
        this.updateCharts();
    },

    // Update display mode
    updateDisplayMode(mode) {
        const channelCards = document.querySelectorAll('.channel-card');

        channelCards.forEach(card => {
            const channel = parseInt(card.dataset.channel);

            if (mode === 'all') {
                card.style.display = 'block';
            } else if (mode === '1-4') {
                card.style.display = channel <= 4 ? 'block' : 'none';
            } else if (mode === '5-8') {
                card.style.display = channel > 4 ? 'block' : 'none';
            }
        });
    },

    // Update connection status UI
    updateConnectionStatus(status) {
        const indicator = document.getElementById('statusIndicator');
        const statusText = document.getElementById('statusText');

        indicator.className = 'status-indicator ' + status;

        switch (status) {
            case 'connected':
                statusText.textContent = 'Connected';
                break;
            case 'connecting':
                statusText.textContent = 'Connecting...';
                break;
            case 'disconnected':
            default:
                statusText.textContent = 'Disconnected';
        }
    },

    // Update button states
    updateButtonStates() {
        const btnStart = document.getElementById('btnStart');
        const btnStop = document.getElementById('btnStop');

        if (this.config.streaming) {
            btnStart.disabled = true;
            btnStop.disabled = false;
        } else {
            btnStart.disabled = false;
            btnStop.disabled = true;
        }
    },

    // Show error message
    showError(message) {
        if (typeof PiConnect !== 'undefined' && PiConnect.showToast) {
            PiConnect.showToast(message, 'error');
        } else {
            alert(message);
        }
    },

    // Show success message
    showSuccess(message) {
        if (typeof PiConnect !== 'undefined' && PiConnect.showToast) {
            PiConnect.showToast(message, 'success');
        } else {
            alert(message);
        }
    },

    // Poll Pi until recording is done, then load EDF data
    _pollRecording(ip) {
        let pollCount = 0;
        const resultsPanel = document.getElementById('inferenceResultsPanel');
        const resultsContent = document.getElementById('inferenceResultsContent');
        const tagsContainer = document.getElementById('inferenceTags');

        if (resultsPanel) {
            resultsPanel.style.display = 'block';
            resultsContent.innerHTML = '<span class="inference-waiting"><i class="fas fa-circle-notch fa-spin"></i> Connecting to Pi... initiated recording sequence.</span>';
            tagsContainer.innerHTML = '';
        }

        const interval = setInterval(async () => {
            pollCount++;
            try {
                const resp = await fetch(`/pi-eeg-status?ip=${ip}`);
                const status = await resp.json();

                if (resultsContent && !status.done) {
                    resultsContent.innerHTML = `<span class="inference-waiting"><i class="fas fa-circle-notch fa-spin"></i> Recording in progress... (tick ${pollCount}) &mdash; Pi is actively processing the session.</span>`;
                }

                if (status.done) {
                    clearInterval(interval);
                    this.config.streaming = false;
                    this.updateButtonStates();

                    // Display Inference Results from Python STDOUT
                    if (resultsPanel) {
                        resultsPanel.style.display = 'block';
                        tagsContainer.innerHTML = '';
                        if (status.output) {
                            resultsContent.innerHTML = this._renderInferenceOutput(status.output);

                            // Extract chunk labels for tag badges
                            const chunkLabelMatch = status.output.match(/Chunk Labels:\s*(.+)/);
                            if (chunkLabelMatch) {
                                chunkLabelMatch[1].split(',').forEach(part => {
                                    const label = part.trim();
                                    if (label) {
                                        const badge = document.createElement('span');
                                        badge.className = 'inference-chunk-tag';
                                        badge.textContent = label;
                                        tagsContainer.appendChild(badge);
                                    }
                                });
                            }
                            if (!tagsContainer.children.length) {
                                tagsContainer.innerHTML = '<span class="inference-waiting">No chunk labels detected.</span>';
                            }
                        } else if (!status.success) {
                            resultsContent.innerHTML = `<span class="inference-error"><i class="fas fa-exclamation-triangle"></i> Recording Failed: ${status.error || 'No output returned'}</span>`;
                        } else {
                            resultsContent.innerHTML = '<span class="inference-waiting">Session finished but no output was returned.</span>';
                        }
                    }

                    if (status.success) {
                        this._loadEdfData(ip);
                    } else {
                        this.showError('Recording failed: ' + (status.error || 'Unknown error'));
                        this.updateConnectionStatus('disconnected');
                        const piStatusInfo = document.getElementById('piStatusInfo');
                        if (piStatusInfo) piStatusInfo.textContent = 'Error';
                    }
                }
            } catch (err) {
                clearInterval(interval);
                this.config.streaming = false;
                this.updateButtonStates();
                this.showError('Lost contact with Pi: ' + err.message);
                
                if (resultsContent) {
                    resultsContent.innerHTML = `<span style="color: #ef4444;">Connection Error:</span><br>${err.message}`;
                }
            }
        }, 2000);
    },

    // Parse inference output text into structured HTML
    _renderInferenceOutput(text) {
        const parse = (key) => {
            const m = text.match(new RegExp(key + ':\\s*(.+)'));
            return m ? m[1].trim() : null;
        };

        const diagnosis   = parse('Final Diagnosis');
        const session     = parse('Session');
        const chunks      = parse('Chunks Processed');
        const votes       = parse('Chunk Votes');
        const stage1      = parse('Avg Stage-1 Probs');
        const stage2      = parse('Avg Stage-2 Probs');

        let html = '';

        if (diagnosis) {
            html += `
            <div class="inference-diagnosis-banner">
                <div>
                    <div class="inference-diagnosis-label">Final Diagnosis</div>
                    <div class="inference-diagnosis-value">${diagnosis}</div>
                </div>
            </div>`;
        }

        const stats = [];
        if (session)  stats.push({ label: 'Session', value: session.replace('→', '&rarr;') });
        if (chunks)   stats.push({ label: 'Chunks Processed', value: chunks });
        if (votes)    stats.push({ label: 'Chunk Votes', value: votes });
        if (stage1)   stats.push({ label: 'Avg Stage-1 Probs', value: stage1 });
        if (stage2)   stats.push({ label: 'Avg Stage-2 Probs', value: stage2 });

        if (stats.length) {
            html += '<div class="inference-stats-grid">';
            stats.forEach(s => {
                html += `<div class="inference-stat-item">
                    <div class="inference-stat-label">${s.label}</div>
                    <div class="inference-stat-value">${s.value}</div>
                </div>`;
            });
            html += '</div>';
        }

        return html || `<span class="inference-waiting">${text}</span>`;
    },

    // Fetch EDF channel data from Pi and render in charts
    async _loadEdfData(ip) {
        const piStatusInfo = document.getElementById('piStatusInfo');
        if (piStatusInfo) { piStatusInfo.textContent = 'Loading data...'; piStatusInfo.style.color = '#f59e0b'; }

        try {
            const resp = await fetch(`/pi-eeg-data?ip=${ip}`);
            const result = await resp.json();

            if (!result.success) {
                this.showError('Failed to read EDF: ' + result.error);
                return;
            }

            // Populate charts with EDF channel data
            result.channels.forEach((ch, i) => {
                if (i >= this.config.channels) return;
                this.dataBuffers[i] = ch.data;

                const valueEl = document.getElementById(`ch${i + 1}Value`);
                if (valueEl) {
                    const last = ch.data[ch.data.length - 1];
                    valueEl.textContent = `${last.toFixed(2)} uV`;
                }
            });

            this.totalDataPoints = result.channels[0] ? result.channels[0].data.length : 0;
            const dataPointsEl = document.getElementById('dataPoints');
            if (dataPointsEl) dataPointsEl.textContent = this.totalDataPoints.toLocaleString();

            this.updateCharts();
            this.updateConnectionStatus('connected');

            if (piStatusInfo) { piStatusInfo.textContent = `Done (${result.duration ? result.duration.toFixed(1) + 's' : ''})`; piStatusInfo.style.color = '#22c55e'; }
            this.showSuccess('EEG data loaded — ' + result.channels.length + ' channels');

        } catch (err) {
            this.showError('Could not load EDF data: ' + err.message);
        }
    }
};

// Global functions for button handlers
async function startStream() {
    if (typeof PiConnect === 'undefined' || !PiConnect.config.ip) {
        EEGLive.showError('Please connect to Raspberry Pi first');
        return;
    }

    const ip = PiConnect.config.ip;
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');
    const piStatusInfo = document.getElementById('piStatusInfo');

    btnStart.disabled = true;
    btnStop.disabled = false;
    EEGLive.updateConnectionStatus('connecting');
    if (piStatusInfo) { piStatusInfo.textContent = 'Recording...'; piStatusInfo.style.color = '#f59e0b'; }

    try {
        const resp = await fetch(`/pi-eeg-start?ip=${ip}`, { method: 'POST' });
        const data = await resp.json();

        if (!data.success) {
            EEGLive.showError('Failed to start recording: ' + (data.error || data.message));
            btnStart.disabled = false;
            btnStop.disabled = true;
            EEGLive.updateConnectionStatus('disconnected');
            return;
        }

        EEGLive.config.streaming = true;
        EEGLive.showSuccess('Recording started on Pi — waiting for EDF...');
        EEGLive._pollRecording(ip);

    } catch (err) {
        EEGLive.showError('Could not reach Pi: ' + err.message);
        btnStart.disabled = false;
        btnStop.disabled = true;
        EEGLive.updateConnectionStatus('disconnected');
    }
}

function stopStream() {
    EEGLive.config.streaming = false;
    EEGLive.updateButtonStates();
    EEGLive.updateConnectionStatus('disconnected');
    EEGLive.showSuccess('Stream stopped');
}

function toggleRecording() {
    const btnRecord = document.getElementById('btnRecord');
    const recordingPanel = document.getElementById('recordingPanel');

    if (!EEGLive.config.recording) {
        // Start recording
        EEGLive.config.recording = true;
        EEGLive.recordingData = [];
        EEGLive.recordingStartTime = Date.now();

        btnRecord.classList.add('recording');
        btnRecord.innerHTML = '<i class="fas fa-stop"></i> Stop Recording';
        recordingPanel.style.display = 'flex';

        // Start recording timer
        EEGLive.recordingTimer = setInterval(() => {
            const elapsed = Date.now() - EEGLive.recordingStartTime;
            const hours = Math.floor(elapsed / 3600000);
            const minutes = Math.floor((elapsed % 3600000) / 60000);
            const seconds = Math.floor((elapsed % 60000) / 1000);

            document.getElementById('recordingDuration').textContent =
                `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

            document.getElementById('recordingSamples').textContent =
                `${EEGLive.recordingData.length} samples`;
        }, 1000);

        EEGLive.showSuccess('Recording started');
    } else {
        // Stop recording
        EEGLive.config.recording = false;
        clearInterval(EEGLive.recordingTimer);

        btnRecord.classList.remove('recording');
        btnRecord.innerHTML = '<i class="fas fa-circle"></i> Record';

        EEGLive.showSuccess(`Recording stopped. ${EEGLive.recordingData.length} samples captured.`);
    }
}

function saveRecording() {
    if (EEGLive.recordingData.length === 0) {
        EEGLive.showError('No data recorded');
        return;
    }

    // Create CSV content
    let csv = 'Timestamp,CH1,CH2,CH3,CH4,CH5,CH6,CH7,CH8\n';

    EEGLive.recordingData.forEach(sample => {
        csv += `${sample.timestamp},${sample.channels.join(',')}\n`;
    });

    // Create download link
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eeg_recording_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    EEGLive.showSuccess('Recording saved as CSV');

    // Hide recording panel
    document.getElementById('recordingPanel').style.display = 'none';
    EEGLive.recordingData = [];
}

function goToClassification() {
    window.location.href = '/results-classification';
}

function goToAutoencoder() {
    window.location.href = '/results-autoencoder';
}

// Sidebar toggle function
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('active');
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    EEGLive.init();
});
