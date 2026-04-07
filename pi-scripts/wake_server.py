from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
import subprocess
import os
import signal
import time
import psutil
import threading
import sys
import glob

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# ===============================
# CONFIGURATION
# ===============================
PI_IP = "172.18.124.246"
UPLOAD_SERVER_PID_FILE = '/tmp/neuromind_upload_server.pid'
UPLOAD_SERVER_SCRIPT = '/home/neuromind/Neuromind/Codes/upload_server.py'
VENV_PYTHON = '/home/neuromind/venvs/neuromind_env/bin/python'
QUERY_SCRIPT = '/home/neuromind/Neuromind/rag/rag/query_data.py'
CLASSIFICATION_SCRIPT = '/home/neuromind/Neuromind/Codes/classification.py'
AUTOENCODER_SCRIPT = '/home/neuromind/Neuromind/Codes/Auto.py'
CLASSIFICATION_WORKDIR = '/home/neuromind/Neuromind/Codes'
AUTOENCODER_WORKDIR = '/home/neuromind/Neuromind/Codes'
OUTPUT_FOLDER = '/home/neuromind/Neuromind/Codes/output'
UPLOAD_SERVER_PORT = 5000

# NEW: CombinedEEGHandler configuration
HANDLER_PATH = '/home/neuromind/Downloads/combined_handler_ds_abnormal_control'
CONFIG_PATH = '/home/neuromind/Downloads/combined_handler_ds_abnormal_control/config_combined.json'
UPLOADS_FOLDER = '/home/neuromind/Neuromind/Codes/uploads'

# Add handler path to sys.path for imports
sys.path.insert(0, HANDLER_PATH)

# Global classification handler (lazy loaded)
_classification_handler = None

# ===============================
# AUTOENCODER JOB STATE
# Shared dict updated by background thread, read by /autoencoder/status
# ===============================
ae_job = {
    'running': False,
    'done': False,
    'success': False,
    'error': None,
    'result': None
}
ae_lock = threading.Lock()

# ===============================
# HELPERS
# ===============================
def is_server_running():
    """Check if upload server is running by PID or by listening port."""
    try:
        # Robust readiness check: the upload server may fork/reload into a child PID.
        for conn in psutil.net_connections(kind='inet'):
            if conn.status == 'LISTEN' and conn.laddr and conn.laddr.port == UPLOAD_SERVER_PORT:
                return True
    except Exception as e:
        print(f"Port check warning: {e}")

    if os.path.exists(UPLOAD_SERVER_PID_FILE):
        try:
            with open(UPLOAD_SERVER_PID_FILE, 'r') as f:
                pid = int(f.read().strip())

            if psutil.pid_exists(pid):
                proc = psutil.Process(pid)
                for conn in proc.connections():
                    if conn.laddr.port == UPLOAD_SERVER_PORT and conn.status == 'LISTEN':
                        return True
                # Parent may still be alive while child handles the listener.
                return proc.is_running()
            return False
        except Exception as e:
            print(f"Error checking server: {e}")
            return False
    return False

def wait_for_server(timeout=10):
    """Wait for upload server to start"""
    start = time.time()
    while time.time() - start < timeout:
        if is_server_running():
            return True
        time.sleep(0.5)
    return False

def parse_section_output(output, section_name):
    """Parse structured output sections like query.py format"""
    lines = output.split('\n')
    in_section = False
    section_lines = []

    for line in lines:
        if line.strip() == f"=== {section_name} ===":
            in_section = True
            continue
        elif line.strip().startswith("=== ") and in_section:
            # Next section started
            break
        elif in_section:
            stripped = line.strip()
            if stripped:
                section_lines.append(stripped)

    return section_lines

def parse_key_value(line):
    """Parse 'Key: Value' format"""
    if ':' in line:
        parts = line.split(':', 1)
        return parts[0].strip(), parts[1].strip()
    return None, None

def get_classification_handler():
    """Lazy load the CombinedEEGHandler"""
    global _classification_handler
    if _classification_handler is None:
        print("🔧 Loading CombinedEEGHandler...")
        from handler_combined import CombinedEEGHandler
        _classification_handler = CombinedEEGHandler(CONFIG_PATH)
        print("✅ CombinedEEGHandler loaded successfully")
    return _classification_handler

# ===============================
# BACKGROUND AUTOENCODER RUNNER
# This runs Auto.py in a thread so the HTTP request returns immediately
# Frontend polls /autoencoder/status for results
# ===============================
def run_autoencoder_background():
    """Background thread that runs the autoencoder script"""
    global ae_job
    try:
        print("🔧 Starting autoencoder background process...")
        result = subprocess.run(
            [VENV_PYTHON, AUTOENCODER_SCRIPT],
            capture_output=True,
            text=True,
            timeout=600,
            cwd=AUTOENCODER_WORKDIR
        )

        combined_output = result.stdout + ('\n' + result.stderr if result.stderr.strip() else '')
        print(f"✅ Autoencoder process completed with return code: {result.returncode}")

        if result.returncode != 0:
            error_lines = parse_section_output(result.stdout, "ERROR")
            error_msg = ' '.join(error_lines) if error_lines else (
                result.stderr.strip() or f'Script exited with code {result.returncode}'
            )
            print(f"❌ Autoencoder error: {error_msg}")
            with ae_lock:
                ae_job['running'] = False
                ae_job['done'] = True
                ae_job['success'] = False
                ae_job['error'] = error_msg
            return

        # Parse ANALYSIS COMPLETE section
        summary_lines = parse_section_output(result.stdout, "ANALYSIS COMPLETE")

        parsed = {
            'file_loaded': 'Unknown',
            'signal_shape': 'Unknown',
            'anomalies_detected': '0/0',
            'anomaly_percentage': '0%',
            'mad_statistics': {
                'mean': '0',
                'max': '0',
                'median': '0',
                'min': '0'
            },
            'output_file': ''
        }

        for line in summary_lines:
            key, value = parse_key_value(line)
            if key == "File Name":
                parsed['file_loaded'] = value
            elif key == "Signal Shape":
                parsed['signal_shape'] = value
            elif key == "Anomalies Detected":
                parsed['anomalies_detected'] = value
            elif key == "Anomaly Percentage":
                parsed['anomaly_percentage'] = value
            elif key == "MAD Mean":
                parsed['mad_statistics']['mean'] = value
            elif key == "MAD Max":
                parsed['mad_statistics']['max'] = value
            elif key == "MAD Median":
                parsed['mad_statistics']['median'] = value
            elif key == "MAD Min":
                parsed['mad_statistics']['min'] = value
            elif key == "Output File":
                parsed['output_file'] = value

        # Parse MAD STATISTICS section for detailed stats
        mad_lines = parse_section_output(result.stdout, "MAD STATISTICS")
        detailed_stats = {}
        for line in mad_lines:
            key, value = parse_key_value(line)
            if key:
                detailed_stats[key] = value

        # Parse timing
        timing_lines = parse_section_output(result.stdout, "TIMING")
        timing = timing_lines[0] if timing_lines else "N/A"

        # Extract just the filename from the full output file path
        output_filename = ''
        if parsed['output_file']:
            output_filename = os.path.basename(parsed['output_file'])

        reconstruction_url = f"http://{PI_IP}:5001/output/{output_filename}" if output_filename else ''

        print(f"📊 Autoencoder results parsed successfully")
        with ae_lock:
            ae_job['running'] = False
            ae_job['done'] = True
            ae_job['success'] = True
            ae_job['error'] = None
            ae_job['result'] = {
                'parsed_data': parsed,
                'detailed_stats': detailed_stats,
                'timing': timing,
                'raw_output': combined_output,
                'reconstruction_url': reconstruction_url,
                'output_filename': output_filename
            }

    except subprocess.TimeoutExpired:
        print("⏱️ Autoencoder timeout (>10 minutes)")
        with ae_lock:
            ae_job['running'] = False
            ae_job['done'] = True
            ae_job['success'] = False
            ae_job['error'] = 'Autoencoder script timeout (>10 minutes)'
    except Exception as e:
        print(f"❌ Autoencoder exception: {str(e)}")
        with ae_lock:
            ae_job['running'] = False
            ae_job['done'] = True
            ae_job['success'] = False
            ae_job['error'] = str(e)

# ===============================
# API ENDPOINTS
# ===============================

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    upload_status = 'running' if is_server_running() else 'stopped'
    return jsonify({
        'status': 'healthy',
        'ip': PI_IP,
        'upload_server': upload_status
    }), 200

@app.route('/wake', methods=['POST'])
def wake():
    """Start the upload server"""
    try:
        if is_server_running():
            return jsonify({
                'success': True,
                'message': 'Upload server already running',
                'already_running': True
            }), 200

        print("🚀 Starting upload server...")
        process = subprocess.Popen(
            [VENV_PYTHON, UPLOAD_SERVER_SCRIPT],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=os.setsid
        )

        with open(UPLOAD_SERVER_PID_FILE, 'w') as f:
            f.write(str(process.pid))

        if wait_for_server(timeout=20):
            print(f"✅ Upload server started successfully (PID: {process.pid})")
            return jsonify({
                'success': True,
                'message': 'Upload server started successfully',
                'pid': process.pid
            }), 200
        else:
            stderr_tail = ''
            if process.poll() is not None:
                try:
                    _, stderr_data = process.communicate(timeout=1)
                    stderr_tail = (stderr_data or '').strip()
                except Exception:
                    stderr_tail = ''

            print("⚠️ Upload server started but not responding")
            return jsonify({
                'success': False,
                'message': 'Upload server started but not responding',
                'details': stderr_tail or f'No listener detected on port {UPLOAD_SERVER_PORT}'
            }), 500

    except Exception as e:
        print(f"❌ Failed to start upload server: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'Failed to start upload server: {str(e)}'
        }), 500

@app.route('/shutdown', methods=['POST'])
def shutdown():
    """Stop the upload server"""
    try:
        if not is_server_running():
            return jsonify({
                'success': True,
                'message': 'Upload server not running'
            }), 200

        with open(UPLOAD_SERVER_PID_FILE, 'r') as f:
            pid = int(f.read().strip())

        print(f"🛑 Stopping upload server (PID: {pid})...")
        os.killpg(os.getpgid(pid), signal.SIGTERM)
        time.sleep(1)

        if os.path.exists(UPLOAD_SERVER_PID_FILE):
            os.remove(UPLOAD_SERVER_PID_FILE)

        print("✅ Upload server stopped")
        return jsonify({
            'success': True,
            'message': 'Upload server stopped'
        }), 200

    except Exception as e:
        print(f"❌ Failed to stop server: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'Failed to stop server: {str(e)}'
        }), 500

# ===============================
# AUTOENCODER ENDPOINTS
# ===============================

@app.route('/autoencoder/start', methods=['POST'])
def autoencoder_start():
    """
    Start autoencoder in background thread.
    Returns immediately, frontend polls /autoencoder/status for results.
    """
    global ae_job
    with ae_lock:
        if ae_job['running']:
            return jsonify({
                'success': True,
                'message': 'Autoencoder already running'
            }), 200

        # Reset state for fresh run
        ae_job = {
            'running': True,
            'done': False,
            'success': False,
            'error': None,
            'result': None
        }

    print("🎬 Starting autoencoder thread...")
    t = threading.Thread(target=run_autoencoder_background, daemon=True)
    t.start()

    return jsonify({
        'success': True,
        'message': 'Autoencoder started in background'
    }), 200

@app.route('/autoencoder/status', methods=['GET'])
def autoencoder_status():
    """
    Poll endpoint for autoencoder status.
    Returns: running / done+success / done+error / idle
    """
    with ae_lock:
        if ae_job['running']:
            return jsonify({'state': 'running'}), 200
        if ae_job['done'] and ae_job['success']:
            return jsonify({
                'state': 'done',
                'success': True,
                **ae_job['result']
            }), 200
        if ae_job['done'] and not ae_job['success']:
            return jsonify({
                'state': 'done',
                'success': False,
                'error': ae_job['error']
            }), 200
        # Not started yet
        return jsonify({'state': 'idle'}), 200

# ===============================
# CLASSIFICATION ENDPOINT (UPDATED - Uses CombinedEEGHandler)
# ===============================

@app.route('/classify', methods=['POST'])
def classify():
    """
    Run two-stage classification using CombinedEEGHandler.
    Returns the full result dict with stage1/stage2 details.
    """
    try:
        start_time = time.time()
        print("🧠 Running two-stage classification with CombinedEEGHandler...")

        # Find the most recent EDF file in uploads folder
        edf_files = glob.glob(os.path.join(UPLOADS_FOLDER, '*.edf'))
        if not edf_files:
            print("❌ No EDF file found in uploads folder")
            return jsonify({
                'success': False,
                'error': 'No EDF file found in uploads folder. Please upload an EDF file first.'
            }), 400

        # Get most recent file
        edf_path = max(edf_files, key=os.path.getmtime)
        print(f"📁 Processing file: {os.path.basename(edf_path)}")

        # Get handler and run prediction
        handler = get_classification_handler()
        result = handler.predict_file(edf_path)

        # Calculate timing
        elapsed = time.time() - start_time
        timing = f"{elapsed:.2f}s"

        # Convert result to JSON-serializable format
        # (remove window_results DataFrame, keep everything else)
        response_result = {
            'subject_id': result.get('subject_id', 'Unknown'),
            'final_label': result.get('final_label', 'Unknown'),
            'n_windows': result.get('n_windows', 0),
            'stage1_prediction': result.get('stage1_prediction'),
            'stage1_confidence': result.get('stage1_confidence'),
            'stage1_votes': result.get('stage1_votes'),
            'stage1_mean_probs': result.get('stage1_mean_probs'),
            'stage2_prediction': result.get('stage2_prediction'),
            'stage2_confidence': result.get('stage2_confidence'),
            'stage2_votes': result.get('stage2_votes'),
            'stage2_mean_probs': result.get('stage2_mean_probs'),
        }

        print(f"✅ Classification complete in {timing}")
        print(f"   📊 Final Label: {response_result['final_label']}")
        print(f"   📊 Stage 1: {response_result['stage1_prediction']} (conf: {response_result['stage1_confidence']})")
        if response_result['stage2_prediction']:
            print(f"   📊 Stage 2: {response_result['stage2_prediction']} (conf: {response_result['stage2_confidence']})")
        else:
            print(f"   📊 Stage 2: Skipped (Stage 1 was not DS)")

        return jsonify({
            'success': True,
            'result': response_result,
            'timing': timing
        }), 200

    except FileNotFoundError as e:
        print(f"❌ File not found: {str(e)}")
        return jsonify({
            'success': False,
            'error': f'File not found: {str(e)}'
        }), 404
    except RuntimeError as e:
        print(f"❌ Runtime error: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
    except Exception as e:
        print(f"❌ Classification exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# ===============================
# QUERY (RAG) ENDPOINT
# ===============================

@app.route('/query', methods=['POST'])
def query():
    """Run query script (RAG chatbot) - Enhanced with better error handling"""
    try:
        data = request.get_json()
        # Accept both 'question' (from frontend) and 'query' for compatibility
        query_text = data.get('question', '') or data.get('query', '')

        if not query_text:
            return jsonify({
                'success': False,
                'error': 'No query provided'
            }), 400

        print(f"💬 Processing RAG query: '{query_text[:50]}...'")
        result = subprocess.run(
            [VENV_PYTHON, QUERY_SCRIPT, query_text],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=os.path.dirname(QUERY_SCRIPT)
        )

        combined_output = result.stdout + ('\n' + result.stderr if result.stderr.strip() else '')
        print(f"✅ Query completed with return code: {result.returncode}")

        # Check for errors even if return code is 0
        if result.returncode != 0:
            error_lines = parse_section_output(result.stdout, "ERROR")
            if error_lines:
                error_msg = ' '.join(error_lines)
                print(f"❌ Query error: {error_msg}")
                return jsonify({
                    'success': False,
                    'error': error_msg,
                    'raw_output': combined_output
                }), 500

        # Parse response
        response_lines = parse_section_output(result.stdout, "RESPONSE")
        response_text = '\n'.join(response_lines) if response_lines else "No response generated"

        # Parse sources
        source_lines = parse_section_output(result.stdout, "SOURCES")
        sources = source_lines if source_lines else []

        # Parse timing
        timing_lines = parse_section_output(result.stdout, "TIMING")
        timing = timing_lines[0] if timing_lines else "N/A"

        print(f"📚 Query response generated successfully ({len(response_text)} chars)")
        return jsonify({
            'success': True,
            'response': response_text,
            'sources': sources,
            'timing': timing,
            'raw_output': combined_output
        }), 200

    except subprocess.TimeoutExpired:
        print("⏱️ Query timeout (>2 minutes)")
        return jsonify({
            'success': False,
            'error': 'Query timeout (>2 minutes)'
        }), 500
    except Exception as e:
        print(f"❌ Query exception: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# ===============================
# OUTPUT FILE SERVING
# ===============================

@app.route('/output/<filename>', methods=['GET'])
def serve_output_file(filename):
    """
    Serve files from the output folder (for autoencoder reconstruction HTML)
    """
    try:
        file_path = os.path.join(OUTPUT_FOLDER, filename)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            print(f"📂 Serving output file: {filename}")
            return send_file(file_path)
        else:
            print(f"❌ Output file not found: {filename}")
            return jsonify({
                'success': False,
                'error': f'File not found: {filename}'
            }), 404
    except Exception as e:
        print(f"❌ Error serving file: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# ===============================
# MAIN
# ===============================

if __name__ == '__main__':
    print("=" * 70)
    print("🧠 NEUROMIND WAKE SERVER - WITH CombinedEEGHandler")
    print("=" * 70)
    print(f"📡 Server URL: http://{PI_IP}:5001")
    print()
    print("📋 Available Endpoints:")
    print("   GET  /health                  - Server health check")
    print("   POST /wake                    - Start upload server")
    print("   POST /shutdown                - Stop upload server")
    print()
    print("   POST /autoencoder/start       - Start autoencoder (background)")
    print("   GET  /autoencoder/status      - Poll for autoencoder results")
    print("   POST /classify                - Run two-stage classification")
    print("   POST /query                   - RAG chatbot query")
    print()
    print("   GET  /output/<filename>       - Serve output files")
    print()
    print("📁 Classification Config:")
    print(f"   Handler: {HANDLER_PATH}")
    print(f"   Config:  {CONFIG_PATH}")
    print(f"   Uploads: {UPLOADS_FOLDER}")
    print("=" * 70)
    print("🚀 Server starting on 0.0.0.0:5001...")
    print()
    app.run(host='0.0.0.0', port=5001, debug=False)
