// ── Get Pi IP from PiConnect (no hardcoded IP) ──
        function getPiIp() {
            if (typeof PiConnect !== 'undefined' && PiConnect.config?.ip) {
                return PiConnect.config.ip;
            }
            return localStorage.getItem('pi_ip') || '';
        }

        function getPiBaseUrl() {
            const ip = getPiIp();
            return ip ? `http://${ip}:5001` : '';
        }

        function getStartUrl() {
            const base = getPiBaseUrl();
            return base ? `${base}/autoencoder/start` : '';
        }

        function getStatusUrl() {
            const base = getPiBaseUrl();
            return base ? `${base}/autoencoder/status` : '';
        }

        let pollInterval = null;
        let elapsedSec   = 0;
        let timerInterval = null;
        let START_URL = '';
        let STATUS_URL = '';
        let PI_BASE = '';

        // ─────────────────────────────────────────
        // OVERLAY HELPERS
        // ─────────────────────────────────────────
        function setLoadingText(status, detail) {
            const s = document.getElementById('loading-status');
            const d = document.getElementById('loading-detail');
            if (s) s.textContent = status;
            if (d) d.textContent = detail;
        }

        function hideOverlay() {
            const ov = document.getElementById('loading-overlay');
            ov.style.opacity = '0';
            ov.style.pointerEvents = 'none';
            setTimeout(() => ov.style.display = 'none', 500);
        }

        function showError(title, detail) {
            stopPolling();
            const ov = document.getElementById('loading-overlay');
            ov.style.display = 'flex';
            ov.style.opacity = '1';
            ov.style.pointerEvents = 'auto';
            ov.innerHTML = `
                <div class="error-box">
                    <div class="error-icon"><i class="fas fa-exclamation-triangle"></i></div>
                    <div class="error-title">${title}</div>
                    <div class="error-message">${detail}</div>
                    <div class="error-actions">
                        <button class="btn-retry" onclick="startAnalysis()">
                            <i class="fas fa-redo"></i> Retry
                        </button>
                        <a class="btn-goback" href="/classification">
                            <i class="fas fa-arrow-left"></i> Go Back
                        </a>
                    </div>
                </div>`;
        }

        function restoreOverlay() {
            const ov = document.getElementById('loading-overlay');
            ov.style.display = 'flex';
            ov.style.opacity = '1';
            ov.style.pointerEvents = 'auto';
            ov.innerHTML = `
                <div class="loader"></div>
                <p id="loading-status">Starting autoencoder on Raspberry Pi...</p>
                <p id="loading-detail">Auto.py is running — this may take several minutes</p>
                <p id="loading-timer">Elapsed: 0s</p>`;
        }

        // ─────────────────────────────────────────
        // TIMER
        // ─────────────────────────────────────────
        function startTimer() {
            elapsedSec = 0;
            timerInterval = setInterval(() => {
                elapsedSec++;
                const el = document.getElementById('loading-timer');
                if (el) el.textContent = `Elapsed: ${elapsedSec}s`;
            }, 1000);
        }

        function stopTimer() {
            if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        }

        // ─────────────────────────────────────────
        // STOP POLLING
        // ─────────────────────────────────────────
        function stopPolling() {
            if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
            stopTimer();
        }

        // ─────────────────────────────────────────
        // POPULATE RESULTS — called when Pi returns done+success
        // ─────────────────────────────────────────
        function populateResults(data) {
            const res = data.parsed_data || {};

            // Update header info
            document.getElementById('pi-file-info').innerText =
                `File: ${res.file_loaded || 'Unknown'} • ${res.signal_shape || ''}`;

            // Update metric cards
            const anomCount = res.anomalies_detected || '0';
            document.getElementById('pi-anomaly-count').innerText = anomCount;

            const tp = res.tp || 0;
            const fn = res.fn || 0;
            const fp = res.fp || 0;
            const da = res.da || 0;

            document.getElementById('pi-detection-stats').innerText = `TP: ${tp}  FN: ${fn}`;

            // Populate log table
            const prec = (tp + fp) > 0 ? (tp / (tp + fp)) : 0;
            const rec  = (tp + fn) > 0 ? (tp / (tp + fn)) : 0;
            const f1   = (prec + rec) > 0 ? (2 * prec * rec / (prec + rec)) : 0;

            document.getElementById('pi-log-body').innerHTML = `
                <tr>
                    <td>True Positives (Seizures Detected)</td>
                    <td>${tp}</td>
                    <td><span class="${tp > 0 ? 'badge-normal' : 'badge-warning'}">${tp > 0 ? 'Detected' : 'None'}</span></td>
                </tr>
                <tr>
                    <td>False Negatives (Seizures Missed)</td>
                    <td>${fn}</td>
                    <td><span class="${fn === 0 ? 'badge-normal' : 'badge-critical'}">${fn === 0 ? 'None Missed' : 'Missed'}</span></td>
                </tr>
                <tr>
                    <td>False Positives (False Alarms)</td>
                    <td>${fp}</td>
                    <td><span class="${fp < 5 ? 'badge-normal' : 'badge-warning'}">${fp < 5 ? 'Low' : 'High'}</span></td>
                </tr>
                <tr>
                    <td>Detected Annotations (DA)</td>
                    <td>${da}</td>
                    <td><span class="badge-normal">Info</span></td>
                </tr>
                <tr>
                    <td>Precision / Recall / F1</td>
                    <td>${prec.toFixed(2)} / ${rec.toFixed(2)} / ${f1.toFixed(2)}</td>
                    <td><span class="${rec >= 0.5 ? 'badge-normal' : 'badge-critical'}">Overall</span></td>
                </tr>`;

            // ─────────────────────────────────────────
            //  RECONSTRUCTION PLOT — open in new tab
            // ─────────────────────────────────────────
            let reconUrl = data.reconstruction_url || '';
            if (!reconUrl || reconUrl.trim() === '') {
                reconUrl = `${PI_BASE}/output/inference.html`;
            }

            console.log('Reconstruction URL:', reconUrl);

            // Hide dummy animation, load plot inline via Node.js proxy
            document.getElementById('ae-placeholder').style.display = 'none';
            const resultDiv = document.getElementById('ae-result');
            resultDiv.style.display = 'block';
            const piIp = getPiIp();
            document.getElementById('plot-frame').src = `/pi-plot?ip=${piIp}`;

            hideOverlay();
        }

        // ─────────────────────────────────────────
        // POLL /autoencoder/status every 3 seconds
        // ─────────────────────────────────────────
        async function pollStatus() {
            try {
                const resp = await fetch(STATUS_URL, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                });

                if (!resp.ok) {
                    const txt = await resp.text();
                    showError('Pi Server Error', `HTTP ${resp.status}\n\n${txt}`);
                    return;
                }

                const data = await resp.json();

                if (data.state === 'running') {
                    setLoadingText(
                        'Auto.py is running on Pi...',
                        'Analyzing EDF signal — anomaly detection in progress'
                    );
                    return;
                }

                if (data.state === 'done') {
                    stopPolling();
                    if (data.success) {
                        populateResults(data);
                    } else {
                        showError(
                            'Autoencoder Analysis Failed',
                            data.error || 'Auto.py returned an error — check uploads folder has an EDF file'
                        );
                    }
                    return;
                }

                if (data.state === 'idle') {
                    setLoadingText('Waiting for Pi to start...', 'Retrying start...');
                    await triggerStart();
                }

            } catch (err) {
                console.warn('Poll error (will retry):', err.message);
                setLoadingText('Polling Pi...', `Connection issue — retrying... (${err.message})`);
            }
        }

        // ─────────────────────────────────────────
        // STEP 1: POST /autoencoder/start
        // ─────────────────────────────────────────
        async function triggerStart() {
            const resp = await fetch(START_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({})
            });

            if (!resp.ok) {
                const txt = await resp.text();
                throw new Error(`HTTP ${resp.status}\n\n${txt}`);
            }

            const data = await resp.json();
            if (!data.success) {
                throw new Error(data.message || 'Failed to start autoencoder');
            }
        }

        async function startAnalysis() {
            restoreOverlay();
            startTimer();

            try {
                setLoadingText('Sending start command to Pi...', 'Calling /autoencoder/start');
                await triggerStart();

                setLoadingText('Auto.py started on Pi!', 'Polling for results every 3 seconds...');
                pollInterval = setInterval(pollStatus, 3000);
                await pollStatus();

            } catch (err) {
                const isNetwork = err instanceof TypeError;
                showError(
                    isNetwork ? 'Cannot Reach Raspberry Pi' : 'Failed to Start Autoencoder',
                    isNetwork
                        ? `Network error — is wake_server.py running on port 5001?\n\n${err.message}`
                        : err.message
                );
            }
        }

        // ─────────────────────────────────────────
        // SIDEBAR
        // ─────────────────────────────────────────
        function toggleSidebar() { document.getElementById('sidebar').classList.toggle('active'); }

        // ─────────────────────────────────────────
        // BACKGROUND ANIMATION
        // ─────────────────────────────────────────
        function initBgAnimation() {
            const canvas = document.getElementById('neuro-bg');
            const ctx = canvas.getContext('2d');
            let width, height, particles = [];
            function resize() {
                width = canvas.width = window.innerWidth;
                height = canvas.height = window.innerHeight;
                particles = [];
                const count = Math.floor(width / 15);
                for (let i = 0; i < count; i++) {
                    particles.push({ x: Math.random()*width, y: Math.random()*height, vx:(Math.random()-0.5)*0.5, vy:(Math.random()-0.5)*0.5, size:Math.random()*2.5+1 });
                }
            }
            function animate() {
                ctx.clearRect(0, 0, width, height);
                ctx.fillStyle = 'rgba(168,85,247,0.9)';
                ctx.strokeStyle = 'rgba(168,85,247,0.2)';
                for (let i = 0; i < particles.length; i++) {
                    let p = particles[i];
                    p.x += p.vx; p.y += p.vy;
                    if (p.x < 0 || p.x > width) p.vx *= -1;
                    if (p.y < 0 || p.y > height) p.vy *= -1;
                    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
                    for (let j = i+1; j < particles.length; j++) {
                        let p2 = particles[j];
                        let dist = Math.sqrt((p.x-p2.x)**2+(p.y-p2.y)**2);
                        if (dist < 120) { ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p2.x,p2.y); ctx.stroke(); }
                    }
                }
                requestAnimationFrame(animate);
            }
            window.addEventListener('resize', resize);
            resize(); animate();
        }

        // ─────────────────────────────────────────
        // WAVE PLOTTER (shown before results arrive)
        // ─────────────────────────────────────────
        function initAEAnimation() {
            const canvas = document.getElementById('aeCanvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            let progress = 0;
            const speed = 15;
            function render(limit) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                const cy = canvas.height / 2;
                ctx.beginPath(); ctx.lineWidth = 4; ctx.strokeStyle = '#06b6d4';
                ctx.shadowColor = '#06b6d4'; ctx.shadowBlur = 15;
                for (let x = 0; x < limit; x++) {
                    const y = cy + Math.sin(x*0.02)*60 + Math.sin(x*0.08)*15;
                    x===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
                }
                ctx.stroke(); ctx.shadowBlur = 0;
                ctx.beginPath(); ctx.lineWidth = 3; ctx.strokeStyle = '#e879f9';
                for (let x = 0; x < limit; x++) {
                    const noise = Math.sin(x*0.5)*3 + Math.cos(x*0.9)*2;
                    const y = cy + Math.sin(x*0.02)*55 + Math.sin(x*0.08)*12 + noise;
                    x===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
                }
                ctx.stroke();
            }
            function anim() {
                if (progress < canvas.width) { progress += speed; render(progress); requestAnimationFrame(anim); }
                else render(canvas.width);
            }
            canvas.width  = canvas.parentElement.offsetWidth;
            canvas.height = canvas.parentElement.offsetHeight;
            anim();
        }

        // ─────────────────────────────────────────
        // CHAT
        // ─────────────────────────────────────────
        function toggleChat(show) {
            const panel = document.getElementById('chatPanel');
            const fab = document.getElementById('fabChat');
            if (show) { panel.classList.add('active'); fab.classList.add('hidden'); }
            else { panel.classList.remove('active'); fab.classList.remove('hidden'); }
        }

        function handleKeyPress(e) { if(e.key === 'Enter') sendChatMessage(); }

        async function sendChatMessage() {
            const input = document.getElementById('chatInput');
            const body = document.getElementById('chatBody');
            const txt = input.value.trim();
            if (!txt) return;

            body.innerHTML += `<div class="msg msg-user">${txt}</div>`;
            input.value = '';
            body.scrollTop = body.scrollHeight;

            try {
                const resp = await fetch(`${PI_BASE}/query`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({query: txt})
                });
                const data = await resp.json();
                body.innerHTML += `<div class="msg msg-bot">${data.response || 'No response from AI'}</div>`;
            } catch (e) {
                body.innerHTML += `<div class="msg msg-bot" style="color:#fca5a5">Error: ${e.message}</div>`;
            }
            body.scrollTop = body.scrollHeight;
        }

        // ─────────────────────────────────────────
        // INIT
        // ─────────────────────────────────────────
        window.addEventListener('load', () => {
            START_URL = getStartUrl();
            STATUS_URL = getStatusUrl();
            PI_BASE = getPiBaseUrl();

            initBgAnimation();
            initAEAnimation();
            startAnalysis();
        });