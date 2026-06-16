// ============================================================
// results-classification.js
// Fetches /classify from wake_server (port 5001) and renders
// the two-stage pipeline results from CombinedEEGHandler.
// ============================================================

// ── Pi IP helpers ─────────────────────────────────────────────
function getPiIp() {
    if (typeof PiConnect !== 'undefined' && PiConnect.config?.ip) {
        return PiConnect.config.ip;
    }
    return localStorage.getItem('pi_ip') || '';
}

function getClassifyUrl() {
    const ip = getPiIp();
    return ip ? `http://${ip}:5001/classify` : '';
}

// ── Category from final label string ─────────────────────────
function getCategory(label) {
    if (!label) return 'Unknown';
    const l = label.toLowerCase();
    if (l.includes('control'))                          return 'Control';
    if (l.includes('abnormal'))                         return 'Abnormal';
    if (l === 'ds' || (l.includes('ds') && !l.includes('non'))) return 'DS';
    return 'Unknown';
}

// ── Color / icon map ──────────────────────────────────────────
const COLORS = {
    DS      : { bg: 'rgba(239,68,68,0.2)',   color: '#f87171', border: '#f87171', icon: 'fa-exclamation-triangle' },
    Control : { bg: 'rgba(16,185,129,0.2)',  color: '#34d399', border: '#34d399', icon: 'fa-check-circle'         },
    Abnormal: { bg: 'rgba(245,158,11,0.2)',  color: '#fbbf24', border: '#fbbf24', icon: 'fa-question-circle'      },
    Unknown : { bg: 'rgba(148,163,184,0.2)', color: '#94a3b8', border: '#94a3b8', icon: 'fa-circle-question'      },
};

const DESCRIPTIONS = {
    DS      : 'EEG patterns match clinical indicators for Dravet Syndrome. Please consult a neurologist for further validation.',
    Control : 'No indicators of Dravet Syndrome detected. Patient falls within the control group parameters.',
    Abnormal: 'EEG shows abnormal patterns but does not match Dravet Syndrome profile. Further investigation is recommended.',
    Unknown : 'Classification result is unclear. Please check the EDF file and retry.',
};

// ── Utility: hide the loading overlay ────────────────────────
function hideLoader() {
    const overlay = document.getElementById('loading-overlay');
    if (!overlay) return;
    setTimeout(() => {
        overlay.style.transition = 'opacity 0.5s';
        overlay.style.opacity    = '0';
        setTimeout(() => { overlay.style.display = 'none'; }, 500);
    }, 400);
}

// ── Utility: show error on page ──────────────────────────────
function showError(msg) {
    const statusEl = document.getElementById('metric-status');
    if (statusEl) {
        statusEl.innerText   = 'Failed';
        statusEl.style.color = '#ef4444';
    }
    const errEl = document.getElementById('error-container');
    if (errEl) {
        errEl.innerHTML = `
            <div class="error-box">
                <strong><i class="fas fa-exclamation-circle"></i> Analysis Failed</strong><br>
                ${msg}
            </div>`;
    }
    hideLoader();
}

// ── Format confidence as percentage ──────────────────────────
function formatConfidence(val) {
    if (val === null || val === undefined) return '--';
    // If already a string with %, return as is
    if (typeof val === 'string' && val.includes('%')) return val;
    // Convert decimal to percentage
    const num = parseFloat(val);
    if (isNaN(num)) return '--';
    return `${(num * 100).toFixed(1)}%`;
}

// ── Main: call Pi classify endpoint ──────────────────────────
async function runAnalysis() {
    const API_URL = getClassifyUrl();

    if (!API_URL) {
        showError('Pi not connected. Please connect using the Pi button.');
        if (typeof PiConnect !== 'undefined') PiConnect.openModal();
        return;
    }

    try {
        const response = await fetch(API_URL, {
            method : 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept'      : 'application/json',
            },
            
            body: JSON.stringify({}),
        });

        if (!response.ok) throw new Error(`Server error: HTTP ${response.status}`);
       // console.log(JSON.stringify(data));

        const data = await response.json();

        // wake_server returns: { success, result:{...}, timing }
        if (!data.success) throw new Error(data.error || 'Classification failed on Pi');

        const result = data.result;
        const timing = data.timing || 'N/A';

        // ── Extract fields from CombinedEEGHandler response ──
        const finalLabel = result.final_label || result['results'] || result['Mean Prediction'] || 'Unknown';
        const category   = getCategory(finalLabel);
        const colorSet   = COLORS[category]       || COLORS['Unknown'];
        const desc       = DESCRIPTIONS[category] || '';

        // ── Metrics ───────────────────────────────────────────
        setText('metric-mean', finalLabel);
        setText('metric-conf', formatConfidence(result.stage1_confidence || result['Confidence']));
        setText('metric-duration', result.n_windows ? `${result.n_windows} windows` : (result['File Duration'] || '--'));

        const statusEl = document.getElementById('metric-status');
        if (statusEl) {
            statusEl.innerText   = 'Complete';
            statusEl.style.color = '#34d399';
        }

        // ── Verdict Badge ─────────────────────────────────────
        const badge = document.getElementById('diag-badge');
        if (badge) {
            badge.innerHTML        = `<i class="fas ${colorSet.icon}"></i> ${finalLabel}`;
            badge.className        = 'class-badge';
            badge.style.background = colorSet.bg;
            badge.style.color      = colorSet.color;
            badge.style.border     = `1px solid ${colorSet.border}`;
        }

        // ── Description ───────────────────────────────────────
        setText('diag-description', desc);

        // ── Stage Pipeline details ────────────────────────────
        renderStageDetails(result);

        // ── Probabilities (from stage1_mean_probs) ────────────
        renderProbabilities(result);

        // ── Metadata ──────────────────────────────────────────
        const fileName = result.subject_id || result['file_name'] || '--';
        setText('meta-file',   fileName);
        setText('meta-time',   new Date().toLocaleString());
        setText('meta-timing', timing);
        setText('file-title',  `Report for: ${fileName}`);

        hideLoader();

    } catch (err) {
        console.error('Classification error:', err);
        showError(err.message || 'Unable to connect to Raspberry Pi.');
    }
}

// ── Render two-stage pipeline section ────────────────────────
function renderStageDetails(result) {
    const container = document.getElementById('stage-details');
    if (!container) return;

    // Support both old and new field names
    const s1pred = result.stage1_prediction || result['Stage 1 Prediction'] || '--';
    const s1conf = formatConfidence(result.stage1_confidence || result['Stage 1 Confidence']);
    const s1votes = result.stage1_votes || null;

    const s2pred = result.stage2_prediction || result['Stage 2 Prediction'] || null;
    const s2conf = formatConfidence(result.stage2_confidence || result['Stage 2 Confidence']);
    const s2votes = result.stage2_votes || null;

    const skipped = !s2pred || s2pred.toLowerCase?.().includes('skip');

    // Build Stage 1 HTML
    let html = `
        <div class="stage-block">
            <h4 class="stage-title stage-1">
                <i class="fas fa-filter"></i>&nbsp; Stage 1 — DS vs Control
            </h4>
            <table class="data-table">
                <tr>
                    <td class="td-label">Prediction</td>
                    <td><strong class="stage-pred ${s1pred === 'DS' ? 'pred-ds' : 'pred-control'}">${s1pred}</strong></td>
                </tr>
                <tr>
                    <td class="td-label">Confidence</td>
                    <td>${s1conf}</td>
                </tr>
                ${s1votes ? `
                <tr>
                    <td class="td-label">Votes</td>
                    <td class="votes-cell">${renderVotes(s1votes)}</td>
                </tr>
                ` : ''}
            </table>
            ${result.stage1_mean_probs ? renderMiniProbBars(result.stage1_mean_probs) : ''}
        </div>
        <hr class="stage-divider">`;

    // Build Stage 2 HTML
    if (!skipped) {
        html += `
        <div class="stage-block">
            <h4 class="stage-title stage-2">
                <i class="fas fa-filter"></i>&nbsp; Stage 2 — DS vs Abnormal
            </h4>
            <table class="data-table">
                <tr>
                    <td class="td-label">Prediction</td>
                    <td><strong class="stage-pred ${s2pred === 'DS' ? 'pred-ds' : 'pred-abnormal'}">${s2pred}</strong></td>
                </tr>
                <tr>
                    <td class="td-label">Confidence</td>
                    <td>${s2conf}</td>
                </tr>
                ${s2votes ? `
                <tr>
                    <td class="td-label">Votes</td>
                    <td class="votes-cell">${renderVotes(s2votes)}</td>
                </tr>
                ` : ''}
            </table>
            ${result.stage2_mean_probs ? renderMiniProbBars(result.stage2_mean_probs) : ''}
        </div>`;
    } else {
        html += `
        <div class="stage-block stage-skipped">
            <h4 class="stage-title stage-disabled">
                <i class="fas fa-ban"></i>&nbsp; Stage 2 — Skipped
            </h4>
            <p class="stage-skip-text">
                Stage 1 result was not DS — pipeline stopped early.
            </p>
        </div>`;
    }

    container.innerHTML = html;
}

// ── Render votes as badges ────────────────────────────────────
function renderVotes(votes) {
    if (!votes || typeof votes !== 'object') return '--';
    return Object.entries(votes)
        .map(([label, count]) => `<span class="vote-badge vote-${label.toLowerCase()}">${label}: ${count}</span>`)
        .join(' ');
}

// ── Render mini probability bars for stage ────────────────────
function renderMiniProbBars(probs) {
    if (!probs || typeof probs !== 'object') return '';

    let html = '<div class="mini-prob-container">';
    for (const [label, val] of Object.entries(probs)) {
        const pct = (parseFloat(val) * 100).toFixed(1);
        const colorClass = label.toLowerCase() === 'ds' ? 'bar-ds' :
                          label.toLowerCase() === 'control' ? 'bar-control' : 'bar-abnormal';
        html += `
            <div class="mini-prob-item">
                <span class="mini-prob-label">${label}</span>
                <div class="mini-prob-bar-wrap">
                    <div class="mini-prob-bar ${colorClass}" style="width:${pct}%"></div>
                </div>
                <span class="mini-prob-value">${pct}%</span>
            </div>`;
    }
    html += '</div>';
    return html;
}

// ── Render main probabilities section ─────────────────────────
function renderProbabilities(result) {
    const card = document.getElementById('probabilities-card');
    const list = document.getElementById('prob-list');

    if (!card || !list) return;

    // Use stage1_mean_probs as primary probabilities display
    const probs = result.stage1_mean_probs || result.probabilities || {};

    if (Object.keys(probs).length > 0) {
        card.style.display = 'block';
        list.innerHTML = '';

        for (const [label, val] of Object.entries(probs)) {
            const numVal = parseFloat(val) * 100;
            const pct = numVal.toFixed(1) + '%';
            list.innerHTML += `
                <div class="prob-item">
                    <span class="prob-label">${label}</span>
                    <div class="prob-bar-group">
                        <div class="prob-bar-wrap">
                            <div class="prob-bar-fill" style="width:${numVal}%"></div>
                        </div>
                        <span class="prob-value">${pct}</span>
                    </div>
                </div>`;
        }

        // If stage 2 was run, add those probabilities too
        if (result.stage2_mean_probs && Object.keys(result.stage2_mean_probs).length > 0) {
            list.innerHTML += `<div class="prob-section-divider">Stage 2 Probabilities</div>`;
            for (const [label, val] of Object.entries(result.stage2_mean_probs)) {
                const numVal = parseFloat(val) * 100;
                const pct = numVal.toFixed(1) + '%';
                list.innerHTML += `
                    <div class="prob-item">
                        <span class="prob-label">${label}</span>
                        <div class="prob-bar-group">
                            <div class="prob-bar-wrap">
                                <div class="prob-bar-fill prob-fill-stage2" style="width:${numVal}%"></div>
                            </div>
                            <span class="prob-value">${pct}</span>
                        </div>
                    </div>`;
            }
        }
    } else {
        card.style.display = 'none';
    }
}

// ── Helper: set innerText safely ─────────────────────────────
function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
}

// ── Sidebar toggle ────────────────────────────────────────────
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.toggle('active');
}

// ── Background particle animation ────────────────────────────
function initBg() {
    const canvas = document.getElementById('neuro-bg');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let w = canvas.width  = window.innerWidth;
    let h = canvas.height = window.innerHeight;

    const pts = Array.from({ length: 100 }, () => ({
        x  : Math.random() * w,
        y  : Math.random() * h,
        vx : (Math.random() - 0.5) * 0.8,
        vy : (Math.random() - 0.5) * 0.8,
    }));

    function loop() {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(168, 85, 247, 0.5)';

        pts.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > w) p.vx *= -1;
            if (p.y < 0 || p.y > h) p.vy *= -1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
            ctx.fill();
        });

        requestAnimationFrame(loop);
    }

    window.addEventListener('resize', () => {
        w = canvas.width  = window.innerWidth;
        h = canvas.height = window.innerHeight;
    });

    loop();
}

// ── Entry point ───────────────────────────────────────────────
window.onload = function () {
    initBg();
    runAnalysis();
};
