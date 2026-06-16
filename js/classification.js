
    // ── PI IP - Get from PiConnect (no hardcoded IP) ──
    function getPiIp() {
        // First check PiConnect object, then localStorage
        if (typeof PiConnect !== 'undefined' && PiConnect.config?.ip) {
            return PiConnect.config.ip;
        }
        return localStorage.getItem('pi_ip') || '';
    }

    // Check if Pi is connected
    function isPiConnected() {
        const ip = getPiIp();
        if (!ip) return false;
        if (typeof PiConnect !== 'undefined') {
            return PiConnect.config?.connected || false;
        }
        return !!ip; // If we have an IP, assume it might be connected
    }

    // ── LOAD PATIENTS FROM DATABASE ──
    async function loadPatients() {
        const patientSelect = document.getElementById('patientSelect');
        const token = localStorage.getItem('token');

        if (!token) {
            patientSelect.innerHTML = '<option value="">Please login first</option>';
            return;
        }

        try {
            const response = await fetch('/api/patients', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const patients = await response.json();

                if (patients.length === 0) {
                    patientSelect.innerHTML = '<option value="">No patients found - Add patients first</option>';
                } else {
                    patientSelect.innerHTML = '<option value="">-- Select a Patient --</option>';
                    patients.forEach(patient => {
                        const option = document.createElement('option');
                        option.value = patient._id;
                        option.textContent = `${patient.patientId} - ${patient.name}`;
                        patientSelect.appendChild(option);
                    });
                }
            } else {
                patientSelect.innerHTML = '<option value="">Unable to load patients</option>';
            }
        } catch (error) {
            console.error('Error fetching patients:', error);
            patientSelect.innerHTML = '<option value="">Error loading patients</option>';
        }
    }
    // Dynamic URL getters - uses connected Pi IP
    function getPiWakeUrl() {
        const ip = getPiIp();
        return ip ? `http://${ip}:5001/wake` : '';
    }

    function getPiUploadUrl() {
        const ip = getPiIp();
        return ip ? `http://${ip}:5000/` : '';
    }

    function getPiShutdownUrl() {
        const ip = getPiIp();
        return ip ? `http://${ip}:5001/shutdown` : '';
    }
    
    function toggleSidebar() {
        document.getElementById('sidebar').classList.toggle('active');
    }

    document.getElementById('fileInput').addEventListener('change', async function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const uploadArea    = document.getElementById('uploadArea');
        const uploadIcon    = document.getElementById('uploadIcon');
        const uploadText    = document.getElementById('uploadText');
        const uploadHint    = document.getElementById('uploadHint');
        const statusBox     = document.getElementById('statusBox');
        const statusMessage = document.getElementById('statusMessage');

        // ── CHECK PI CONNECTION FIRST ──
        const piIp = getPiIp();
        if (!piIp) {
            statusBox.className = 'alert-box error';
            statusMessage.innerHTML = '<strong>❌ Error:</strong> Please connect to Raspberry Pi first using the Pi button';
            // Open PiConnect modal if available
            if (typeof PiConnect !== 'undefined') {
                PiConnect.openModal();
            }
            e.target.value = '';
            return;
        }

        try {
            // ── STEP 1: Wake Pi server ──
            uploadArea.classList.add('uploading');
            uploadIcon.className = 'fas fa-spinner fa-spin upload-icon';
            uploadText.textContent = 'Starting Pi Server...';
            uploadHint.textContent = 'Initializing connection...';
            statusBox.className = 'alert-box warning';
            statusMessage.innerHTML = '<strong>🔌 Connecting:</strong> Waking up Raspberry Pi server...';

            // ✅ FIX: Add 'Accept' and 'Content-Type' headers + empty JSON body
            //         so Flask never gets a bad request on the /wake endpoint
            const wakeResponse = await fetch(getPiWakeUrl(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({})
            });

            if (!wakeResponse.ok) {
                const errText = await wakeResponse.text();
                throw new Error(`Failed to wake Pi server (HTTP ${wakeResponse.status}): ${errText}`);
            }

            // Wait for server to stabilise
            await new Promise(resolve => setTimeout(resolve, 3000));

            // ── STEP 2: Upload file ──
            uploadText.textContent = 'Uploading to Raspberry Pi...';
            uploadHint.textContent = file.name;
            statusMessage.innerHTML = '<strong>⏳ Uploading:</strong> Sending file to Pi...';

            const formData = new FormData();
            formData.append('file', file);
            formData.append('callback_url', window.location.origin);
            formData.append('laptop_ip', window.location.hostname || 'localhost');

            // ✅ FIX: Add 'Accept' header so upload_server.py returns JSON
            const uploadResponse = await fetch(getPiUploadUrl(), {
                method: 'POST',
                headers: { 'Accept': 'application/json' },
                body: formData
                // NOTE: do NOT set Content-Type when sending FormData —
                //       the browser must set it automatically with the boundary
            });

            if (!uploadResponse.ok) {
                throw new Error(`Upload failed (HTTP ${uploadResponse.status}) — check upload server on port 5000`);
            }

            const uploadResult = await uploadResponse.json();

            if (!uploadResult.success) {
                throw new Error(uploadResult.message || 'Upload server returned failure');
            }

            // ── Success UI ──
            uploadArea.classList.remove('uploading');
            uploadArea.classList.add('success');
            uploadIcon.className = 'fas fa-check-circle upload-icon';
            uploadIcon.style.color = '#10b981';
            uploadText.textContent = 'Upload Successful!';
            uploadHint.textContent = 'File saved on Raspberry Pi';

            statusBox.className = 'alert-box success';
            statusMessage.innerHTML = `<strong>✅ Success:</strong> ${uploadResult.message}`;

            // Reset after 3 s
            setTimeout(() => {
                uploadArea.classList.remove('success');
                uploadIcon.className = 'fas fa-cloud-upload-alt upload-icon';
                uploadIcon.style.color = '#38bdf8';
                uploadText.textContent = 'Click to Upload EEG Files';
                uploadHint.textContent = 'Supported: .edf';
                statusBox.className = 'alert-box info';
                statusMessage.innerHTML = '<strong>Ready:</strong> Select a file to upload to Raspberry Pi';
                e.target.value = '';
            }, 3000);

        } catch (error) {
            console.error('❌ Error:', error);
            uploadArea.classList.remove('uploading');
            uploadIcon.className = 'fas fa-exclamation-circle upload-icon';
            uploadIcon.style.color = '#ef4444';
            uploadText.textContent = 'Upload Failed';
            uploadHint.textContent = 'Check Pi connection and try again';
            statusBox.className = 'alert-box error';
            // ✅ FIX: Show actual error message, not just generic text
            statusMessage.innerHTML = `<strong>❌ Error:</strong> ${error.message}`;
        }
    });

    // ── BACKGROUND ANIMATION ──
    function initBgAnimation() {
        const canvas = document.getElementById('neuro-bg');
        const ctx = canvas.getContext('2d');
        let width, height, particles = [];

        function resize() {
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
            initParticles();
        }

        function initParticles() {
            particles = [];
            const count = Math.floor(width / 15); 
            for (let i = 0; i < count; i++) {
                particles.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    vx: (Math.random() - 0.5) * 0.5,
                    vy: (Math.random() - 0.5) * 0.5,
                    size: Math.random() * 2.5 + 1 
                });
            }
        }

        function animate() {
            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = 'rgba(168, 85, 247, 0.9)'; 
            ctx.strokeStyle = 'rgba(168, 85, 247, 0.2)'; 

            for (let i = 0; i < particles.length; i++) {
                let p = particles[i];
                p.x += p.vx; p.y += p.vy;
                if (p.x < 0 || p.x > width) p.vx *= -1;
                if (p.y < 0 || p.y > height) p.vy *= -1;

                ctx.shadowBlur = 15;
                ctx.shadowColor = 'rgba(168, 85, 247, 0.9)';
                ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0; 

                for (let j = i + 1; j < particles.length; j++) {
                    let p2 = particles[j];
                    let dist = Math.sqrt((p.x - p2.x)**2 + (p.y - p2.y)**2);
                    if (dist < 120) {
                        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
                    }
                }
            }
            requestAnimationFrame(animate);
        }
        window.addEventListener('resize', resize);
        resize(); animate();
    }

    // ── BRAIN ANIMATION ──
    function initBrainAnimation() {
        const canvas = document.getElementById('canvasCore');
        const ctx = canvas.getContext('2d');
        let width, height, points = [], angleX = 0, angleY = 0;

        function resize() {
            width = canvas.width = canvas.parentElement.offsetWidth;
            height = canvas.height = canvas.parentElement.offsetHeight;
            initPoints();
        }

        function initPoints() {
            points = [];
            const numPoints = 70;
            for (let i = 0; i < numPoints; i++) {
                const y = 1 - (i / (numPoints - 1)) * 2;
                const radiusAtY = Math.sqrt(1 - y * y);
                const theta = i * 2.4;
                points.push({
                    x: Math.cos(theta) * radiusAtY * 85,
                    y: y * 85,
                    z: Math.sin(theta) * radiusAtY * 85
                });
            }
        }

        function rotate(p, aX, aY) {
            let x1 = p.x * Math.cos(aY) - p.z * Math.sin(aY);
            let z1 = p.x * Math.sin(aY) + p.z * Math.cos(aY);
            let y1 = p.y * Math.cos(aX) - z1 * Math.sin(aX);
            let z2 = p.y * Math.sin(aX) + z1 * Math.cos(aX);
            return { x: x1, y: y1, z: z2 };
        }

        function animate() {
            ctx.clearRect(0, 0, width, height);
            const cx = width / 2, cy = height / 2;
            const rotatedPoints = points.map(p => rotate(p, angleX, angleY));

            ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
            ctx.lineWidth = 1;
            for (let i = 0; i < rotatedPoints.length; i++) {
                for (let j = i + 1; j < rotatedPoints.length; j++) {
                    const p1 = rotatedPoints[i], p2 = rotatedPoints[j];
                    const dist = Math.sqrt((p1.x-p2.x)**2 + (p1.y-p2.y)**2 + (p1.z-p2.z)**2);
                    if (dist < 50) {
                        ctx.beginPath(); ctx.moveTo(cx + p1.x, cy + p1.y); ctx.lineTo(cx + p2.x, cy + p2.y); ctx.stroke();
                    }
                }
            }
            rotatedPoints.forEach(p => {
                const scale = (p.z + 200) / 200;
                const alpha = Math.max(0.2, (p.z + 80) / 160);
                ctx.fillStyle = `rgba(56, 189, 248, ${alpha})`;
                ctx.shadowBlur = 10 * scale; ctx.shadowColor = '#38bdf8';
                ctx.beginPath(); ctx.arc(cx + p.x, cy + p.y, 3 * scale, 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0;
            });
            angleY += 0.005; angleX += 0.002;
            requestAnimationFrame(animate);
        }
        window.addEventListener('resize', resize);
        resize(); animate();
    }

    // ── SIGNAL ANIMATION ──
    function initSignalAnimation() {
        const canvas = document.getElementById('canvasSignal');
        const ctx = canvas.getContext('2d');
        let width, height, time = 0;

        function resize() {
            width = canvas.width = canvas.parentElement.offsetWidth;
            height = canvas.height = canvas.parentElement.offsetHeight;
        }

        function animate() {
            ctx.clearRect(0, 0, width, height);
            for (let i = 0; i < 3; i++) {
                ctx.beginPath();
                ctx.strokeStyle = i === 0 ? '#a855f7' : i === 1 ? '#3b82f6' : '#06b6d4';
                ctx.lineWidth = 2;
                for (let x = 0; x < width; x++) {
                    const y = height/2 + Math.sin(x * 0.02 + time + i) * 30 + Math.sin(x * 0.05 + time * 1.5) * 10;
                    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            time += 0.05;
            requestAnimationFrame(animate);
        }
        window.addEventListener('resize', resize);
        resize(); animate();
    }

    // ── Update Pi Status display ──
    function updatePiStatusDisplay() {
        const piStatusEl = document.getElementById('piStatus');
        if (piStatusEl) {
            const ip = getPiIp();
            piStatusEl.textContent = ip || 'Not connected';
        }
    }

    window.onload = function() {
        loadPatients();
        initBgAnimation();
        initBrainAnimation();
        initSignalAnimation();

        // Update Pi Status display on page load
        updatePiStatusDisplay();

        // Also update when PiConnect changes (poll every 2 seconds)
        setInterval(updatePiStatusDisplay, 2000);
    };
    