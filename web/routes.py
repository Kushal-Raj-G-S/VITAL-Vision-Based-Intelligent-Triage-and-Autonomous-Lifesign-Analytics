from flask import render_template, Response, jsonify, request, redirect
from werkzeug.utils import secure_filename
import statistics as stats
import time
import cv2
import numpy as np
import os
import threading
import json
import re
import base64

# Import the web package which holds our shared state and configurations
import web
from core.camera import find_available_cameras
from web.neon_db import init_db, save_patient_record, get_all_patients, clear_all_patients

# Initialize the Postgres DB on startup
init_db()

# Setup decorator shortcuts
app = web.app

def _parse_camera_index(raw_source):
    """Parse optional camera index from request; None means auto-detect."""
    if raw_source is None:
        return None
    if isinstance(raw_source, int):
        return raw_source
    source = str(raw_source).strip()
    if source == '':
        return None
    if source.isdigit() or (source.startswith('-') and source[1:].isdigit()):
        return int(source)
    return None


def _resolve_camera_source(raw_source):
    """Pick a working camera index — explicit choice or first real (non-virtual) device."""
    index = _parse_camera_index(raw_source)
    if index is not None:
        return index
    cam_list = find_available_cameras()
    if not cam_list:
        return None
    # Prefer first non-virtual camera (built-in webcam)
    for cam in cam_list:
        if not cam.get('is_virtual', False):
            return cam['index']
    # Fall back to first available even if virtual
    return cam_list[0]['index']


def release_camera_hardware():
    """Stop streaming and release the video device so the OS unlocks the camera."""
    try:
        web.session.stop_event.set()
        time.sleep(0.1)
        web.session.stop_event.clear()
        with web.session.processing_lock:
            if web.camera is not None:
                web.camera.release_video()
    except Exception as e:
        print(f"[APP] Camera release error: {e}")


def _classify(bpm):
    """
    Clinical heart rate classification (resting, adult) aligned with project PDF:
      < 60        → BRADYCARDIA   (slow)
      60 – 100    → NORMAL
      > 100       → TACHYCARDIA   (fast)
    """
    if not isinstance(bpm, (int, float)):
        return '--'
    if bpm <= 0:
        return 'INVALID'
    if bpm < 60:
        return 'BRADYCARDIA'
    if bpm <= 100:
        return 'NORMAL'
    return 'TACHYCARDIA'


def _classify_respiratory_rate(rr):
    """Adult resting respiratory rate classification (breaths/min) aligned with project PDF:
      < 12        → BRADYPNEA
      12 – 20     → NORMAL
      > 20        → TACHYPNEA
    """
    if not isinstance(rr, (int, float)):
        return '--'
    if rr <= 0:
        return 'INVALID'
    if rr < 12:
        return 'BRADYPNEA'
    if rr <= 20:
        return 'NORMAL'
    return 'TACHYPNEA'


def generate_frames():
    """MJPEG generator. Runs for the lifetime of the /video_feed request."""
    calibration_done = False

    while not web.session.stop_event.is_set():
        frame_bytes, roi_data, is_moving, motion_delta = web.camera.get_frame()

        # ── Video file ended ─────────────────────────────────────────
        if frame_bytes is None:
            print("[APP] Video ended — computing final summary")
            with web.session.processing_lock:
                final = web.rppg_engine.get_final_summary()
                web.session.metrics.update(final)
                web.session.metrics['status']       = 'VIDEO_ENDED'
                web.session.metrics['classification'] = _classify(final.get('final_bpm'))
                web.session.metrics['calibration_done'] = calibration_done
                if not web.session.is_live_camera:
                    web.camera.release_video()
            break

        with web.session.processing_lock:
            web.session.frame_count += 1
            elapsed = time.time() - web.session.start_time

            # Perceptual luminance (ITU-R BT.601) — accurate pseudo-lux
            if roi_data is not None:
                r_ch, g_ch, b_ch = roi_data
                lux = int(0.299 * r_ch + 0.587 * g_ch + 0.114 * b_ch)
            else:
                lux = 0
            web.session.metrics['estimated_lux'] = lux
            web.session.metrics['motion_delta']  = int(motion_delta)

            # Warnings list
            warnings = []
            if is_moving or motion_delta > 15.0:
                warnings.append("Excessive motion — please stay still")
            if roi_data is not None and (lux < 50 or lux > 210):
                warnings.append("Poor lighting — move to better light")

            web.rppg_engine.add_frame(roi_data, elapsed)
            results = web.rppg_engine.process_ppg_signal()

            if results['ready']:
                calibration_done = True
                bpm = results.get('bpm', 0)
                if isinstance(bpm, (int, float)) and bpm > 0:
                    web.session.bpm_history.append(float(bpm))

                # Persist last known-good HRV and stress with EMA smoothing.
                # EMA: new = alpha * raw + (1-alpha) * prev  — damps wild jumps.
                # Stress index (very noisy) → alpha=0.15 (heavy smoothing)
                # HRV → alpha=0.25 (moderate smoothing)
                hrv_now    = results.get('hrv', 0) or 0
                stress_now = results.get('stress_index', 0) or 0
                if hrv_now > 0:
                    if web.session.last_valid_hrv > 0:
                        web.session.last_valid_hrv = 0.25 * hrv_now + 0.75 * web.session.last_valid_hrv
                    else:
                        web.session.last_valid_hrv = hrv_now
                if stress_now > 0:
                    if web.session.last_valid_stress > 0:
                        web.session.last_valid_stress = 0.15 * stress_now + 0.85 * web.session.last_valid_stress
                    else:
                        web.session.last_valid_stress = stress_now


                rr_val = results.get('rr', 0) or 0
                rr_conf = results.get('rr_confidence', 0) or 0
                if rr_conf < 10:
                    rr_val = 0

                web.session.metrics = {
                    'bpm':                  int(bpm) if isinstance(bpm, (int, float)) else 0,
                    'confidence':           int(results.get('confidence', 0)),
                    'status':               results.get('status', 'OK'),
                    'snr_db':               results.get('snr_db', 0),
                    'sqi':                  results.get('sqi', 0),
                    'classification':       _classify(bpm),
                    'ohi':                  results.get('confidence', 0),
                    'stability':            results.get('stability_score', 0),
                    'stability_indicator':  results.get('stability_indicator', '--'),
                    'rr':                   rr_val,
                    'rr_confidence':        rr_conf,
                    'rr_classification':    _classify_respiratory_rate(rr_val),
                    'hrv':                  web.session.last_valid_hrv,
                    'stress_index':         web.session.last_valid_stress,
                    'warnings':             warnings,
                    'remark':               results.get('remark', ''),
                    'estimated_lux':        lux,
                    'motion_delta':         int(motion_delta),
                    'is_live':              web.session.is_live_camera,
                    'calibration_done':     True,
                    'face_detected':        roi_data is not None,
                    'ppg_signal':           results.get('ppg_signal', [])[-150:],
                    'calibration_progress': 100,
                }
            else:
                web.session.metrics['status']           = 'CALIBRATING'
                web.session.metrics['warnings']         = warnings
                web.session.metrics['is_live']          = web.session.is_live_camera
                web.session.metrics['calibration_done'] = False
                web.session.metrics['estimated_lux']    = lux
                web.session.metrics['motion_delta']     = int(motion_delta)
                web.session.metrics['face_detected']    = roi_data is not None
                web.session.metrics['calibration_progress'] = results.get('calibration_progress', 0)
                web.session.metrics['rr']               = results.get('rr', 0)
                web.session.metrics['rr_confidence']    = results.get('rr_confidence', 0)
                web.session.metrics['rr_classification'] = _classify_respiratory_rate(results.get('rr', 0))

        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        time.sleep(0.02)


# ── App Routes ───────────────────────────────────────────────────────

@app.route('/')
def index():
    # Redirect browser visits to the Next.js SaaS frontend on port 3000
    # The Flask server on port 5002 is purely the REST API backend
    return jsonify({
        'service': 'VITAL Opti-Screen API Server',
        'version': '2.0',
        'status': 'running',
        'frontend': 'http://localhost:3000',
        'message': 'Open http://localhost:3000 for the VITAL SaaS dashboard.'
    })


@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')


@app.route('/status')
def status():
    with web.session.processing_lock:
        payload = dict(web.session.metrics)
    return jsonify(payload)


@app.route('/session_summary')
def session_summary():
    """Returns final session statistics built from bpm_history."""
    with web.session.processing_lock:
        history = list(web.session.bpm_history)
        metrics = dict(web.session.metrics)

    if web.session.image_mode and metrics.get('status') == 'IMAGE_READY':
        return jsonify({
            'avg_bpm':        round(metrics.get('bpm', 0), 1),
            'min_bpm':        round(metrics.get('bpm', 0), 1),
            'max_bpm':        round(metrics.get('bpm', 0), 1),
            'stability_pct':  0,
            'rr':             round(metrics.get('rr', 0), 1),
            'rr_classification': metrics.get('rr_classification', '--'),
            'hrv':            round(metrics.get('hrv', 0), 1),
            'stress_index':   round(metrics.get('stress_index', 0), 1),
            'classification': metrics.get('classification', '--'),
            'remark':         metrics.get('remark', ''),
            'sample_count':   0,
        })

    if len(history) >= 2:
        sorted_h = sorted(history)
        n = len(sorted_h)
        q1 = sorted_h[n // 4]
        q3 = sorted_h[(3 * n) // 4]
        iqr = q3 - q1
        lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
        clean = [x for x in sorted_h if lo <= x <= hi] or sorted_h
        avg_bpm = round(stats.mean(clean), 1)
        min_bpm = round(min(clean), 1)
        max_bpm = round(max(clean), 1)
        std_bpm = stats.stdev(clean) if len(clean) > 1 else 0
        stability_pct = round(max(0, min(100, 100 - std_bpm * 4)))
    elif len(history) == 1:
        avg_bpm = min_bpm = max_bpm = round(history[0], 1)
        stability_pct = 0
    else:
        # INSUFFICIENT_DATA — no fake values
        return jsonify({
            'avg_bpm': None, 'min_bpm': None, 'max_bpm': None,
            'stability_pct': 0,
            'rr': round(metrics.get('rr', 0), 1),
            'rr_classification': metrics.get('rr_classification', '--'),
            'hrv': round(metrics.get('hrv', 0), 1),
            'stress_index': round(metrics.get('stress_index', 0), 1),
            'classification': '--',
            'remark': 'INSUFFICIENT_DATA',
            'sample_count': 0,
        })

    payload = {
        'avg_bpm':        avg_bpm,
        'min_bpm':        min_bpm,
        'max_bpm':        max_bpm,
        'stability_pct':  stability_pct,
        'rr':             round(metrics.get('rr', 0), 1),
        'rr_classification': metrics.get('rr_classification', '--'),
        'hrv':            round(metrics.get('hrv', 0), 1),
        'stress_index':   round(metrics.get('stress_index', 0), 1),
        'classification': _classify(avg_bpm),
        'remark':         metrics.get('remark', ''),
        'sample_count':   len(history),
    }

    return jsonify(payload)


def _reset(source, live):
    web.session.stop_event.set()
    time.sleep(0.15)
    web.session.stop_event.clear()
    with web.session.processing_lock:
        if web.camera is not None:
            web.camera.release_video()
        from core.camera import Camera
        from core.rppg import AdvancedRPPG
        web.camera         = Camera(source=source)
        web.rppg_engine    = AdvancedRPPG(fps=30, window_size=300)
        web.session.frame_count    = 0
        web.session.start_time     = time.time()
        web.session.is_live_camera = live
        web.session.image_mode      = False
        web.session.image_frame_bytes = None
        web.session.bpm_history    = []
        web.session.last_valid_hrv    = 0.0
        web.session.last_valid_stress = 0.0
        web.session.metrics.update({
            'bpm': 0, 'status': 'WAITING', 'classification': 'UNKNOWN',
            'rr': 0, 'rr_confidence': 0, 'rr_classification': '--',
            'hrv': 0, 'stress_index': 0, 'warnings': [],
            'estimated_lux': 0, 'motion_delta': 0,
            'is_live': live, 'calibration_done': False,
        })


def _release_session():
    """End active capture and return camera to standby without destroying detectors."""
    web.session.is_live_camera = False
    web.session.stop_event.set()
    time.sleep(0.15)
    web.session.stop_event.clear()
    with web.session.processing_lock:
        web.session.is_live_camera = False
        if web.camera is not None:
            web.camera.release_video()
        web.session.metrics.update({
            'status': 'WAITING',
            'is_live': False,
            'calibration_done': False,
        })


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in web.ALLOWED_EXTENSIONS


def _is_image_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in web.IMAGE_EXTENSIONS


@app.route('/upload', methods=['POST'])
def upload_video():
    if 'video' not in request.files:
        return jsonify({'error': 'No video file provided'}), 400
    file = request.files['video']
    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file'}), 400
    filename  = secure_filename(file.filename)
    # Upload folder relative to package root
    filepath  = os.path.join(app.root_path, '..', web.UPLOAD_FOLDER, filename)
    file.save(filepath)

    if _is_image_file(filename):
        web.session.stop_event.set()
        time.sleep(0.15)
        web.session.stop_event.clear()
        if web.camera is not None:
            web.camera.release_video()
        web.session.is_live_camera = False
        analysis = web.camera.analyze_image_file(filepath)
        if analysis is None:
            return jsonify({'error': 'Invalid image file'}), 400

        with web.session.processing_lock:
            web.session.image_frame_bytes = analysis['frame_bytes']
            web.session.image_mode = True
            web.session.bpm_history.clear()
            web.session.metrics.update({
                'bpm': 72,
                'confidence': 15,
                'status': 'IMAGE_READY',
                'classification': 'NORMAL',
                'rr': 16,
                'rr_confidence': 15,
                'rr_classification': _classify_respiratory_rate(16),
                'hrv': 35,
                'stress_index': 40,
                'warnings': ['Image demo estimate — use live/video for real vitals'],
                'remark': 'IMAGE_DEMO',
                'estimated_lux': analysis['estimated_lux'],
                'motion_delta': 0,
                'is_live': False,
                'calibration_done': True,
                'face_detected': analysis['face_detected'],
                'ppg_signal': [],
                'calibration_progress': 100,
            })

        return jsonify({
            'success': True,
            'message': f'Image uploaded: {filename}',
            'mode': 'image',
        })

    _reset(filepath, live=False)
    return jsonify({'success': True, 'message': f'Video uploaded: {filename}', 'mode': 'video'})


@app.route('/api/cameras')
def list_cameras():
    """Return indices and names of locally available camera devices."""
    cam_list = find_available_cameras()  # list of {index, label, is_virtual}
    # Default = first non-virtual camera
    default_cam = next((c for c in cam_list if not c.get('is_virtual', False)), None)
    default_index = default_cam['index'] if default_cam else (cam_list[0]['index'] if cam_list else None)
    return jsonify({
        'cameras': cam_list,
        'default': default_index,
    })


@app.route('/start_webcam', methods=['POST'])
def start_webcam():
    try:
        payload = request.get_json(silent=True) or {}
        source = _resolve_camera_source(payload.get('source'))
        if source is None:
            return jsonify({
                'success': False,
                'error': 'No camera detected. Connect a webcam and ensure it is not in use by another app.',
            }), 400
        _reset(source, live=True)
        if web.camera.dummy_mode:
            return jsonify({
                'success': False,
                'error': f'Could not open camera index {source}. Try another device from the list.',
            }), 400
        return jsonify({
            'success': True,
            'message': f'Live camera started (index {source})',
            'source': source,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/reset_camera', methods=['POST'])
def reset_camera():
    _release_session()
    return jsonify({'success': True, 'message': 'Camera released'})


@app.route('/release_camera', methods=['POST'])
def release_camera():
    _release_session()
    return jsonify({'success': True, 'message': 'Camera released'})


@app.route('/image_feed')
def image_feed():
    if not web.session.image_mode or web.session.image_frame_bytes is None:
        return jsonify({'error': 'No image loaded'}), 404
    return Response(web.session.image_frame_bytes, mimetype='image/jpeg')


@app.route('/api/stream_frame', methods=['POST'])
def stream_frame():
    try:
        data = request.json or {}
        image_b64 = data.get('image', '')
        if not image_b64:
            return jsonify({'success': False, 'error': 'No image frame provided'}), 400
            
        header, encoded = image_b64.split(",", 1) if "," in image_b64 else ("", image_b64)
        frame_bytes = base64.b64decode(encoded)
        np_arr = np.frombuffer(frame_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        
        if frame is None:
            return jsonify({'success': False, 'error': 'Failed to decode image frame'}), 400
            
        if not web.session.is_live_camera:
            web.session.is_live_camera = True
            web.session.start_time = time.time()
            web.session.frame_count = 0
            web.session.bpm_history = []
            web.session.last_valid_hrv = 0.0
            web.session.last_valid_stress = 0.0
            web.rppg_engine.reset()
            
        web.session.frame_count += 1
        elapsed = time.time() - web.session.start_time
        
        if web.camera.use_mediapipe:
            roi_data, _, motion_delta = web.camera._extract_roi_mediapipe(frame)
        else:
            roi_data, _, motion_delta = web.camera._extract_roi_haar(frame)
            
        lux = 0
        is_moving = web.camera.is_moving
        if roi_data is not None:
            r_ch, g_ch, b_ch = roi_data
            lux = int(0.299 * r_ch + 0.587 * g_ch + 0.114 * b_ch)
            
        web.session.metrics['estimated_lux'] = lux
        web.session.metrics['motion_delta']  = int(motion_delta)
        
        warnings = []
        if is_moving or motion_delta > 15.0:
            warnings.append("Excessive motion — please stay still")
        if roi_data is not None and (lux < 50 or lux > 210):
            warnings.append("Poor lighting — move to better light")
            
        if roi_data is not None:
            web.rppg_engine.add_frame(roi_data, elapsed)
            results = web.rppg_engine.process_ppg_signal()
            
            if results['ready']:
                bpm = results.get('bpm', 0)
                if isinstance(bpm, (int, float)) and bpm > 0:
                    web.session.bpm_history.append(float(bpm))
                    
                hrv_now    = results.get('hrv', 0) or 0
                stress_now = results.get('stress_index', 0) or 0
                if hrv_now > 0:
                    if web.session.last_valid_hrv > 0:
                        web.session.last_valid_hrv = 0.25 * hrv_now + 0.75 * web.session.last_valid_hrv
                    else:
                        web.session.last_valid_hrv = hrv_now
                if stress_now > 0:
                    if web.session.last_valid_stress > 0:
                        web.session.last_valid_stress = 0.15 * stress_now + 0.85 * web.session.last_valid_stress
                    else:
                        web.session.last_valid_stress = stress_now
                        
                rr_val = results.get('rr', 0) or 0
                rr_conf = results.get('rr_confidence', 0) or 0
                if rr_conf < 10:
                    rr_val = 0
                    
                web.session.metrics.update({
                    'bpm':                  int(bpm) if isinstance(bpm, (int, float)) else 0,
                    'confidence':           int(results.get('confidence', 0)),
                    'status':               results.get('status', 'OK'),
                    'snr_db':               results.get('snr_db', 0),
                    'sqi':                  results.get('sqi', 0),
                    'classification':       _classify(bpm),
                    'ohi':                  results.get('confidence', 0),
                    'stability':            results.get('stability_score', 0),
                    'stability_indicator':  results.get('stability_indicator', '--'),
                    'rr':                   rr_val,
                    'rr_confidence':        rr_conf,
                    'rr_classification':    _classify_respiratory_rate(rr_val),
                    'hrv':                  web.session.last_valid_hrv,
                    'stress_index':         web.session.last_valid_stress,
                    'warnings':             warnings,
                    'remark':               results.get('remark', ''),
                    'estimated_lux':        lux,
                    'motion_delta':         int(motion_delta),
                    'is_live':              True,
                    'calibration_done':     True,
                    'face_detected':        True,
                    'ppg_signal':           results.get('ppg_signal', [])[-150:],
                    'calibration_progress': 100,
                })
            else:
                web.session.metrics.update({
                    'status':               'CALIBRATING',
                    'warnings':             warnings,
                    'is_live':              True,
                    'calibration_done':     False,
                    'estimated_lux':        lux,
                    'motion_delta':         int(motion_delta),
                    'face_detected':        True,
                    'calibration_progress': results.get('calibration_progress', 0),
                    'rr':                   results.get('rr', 0),
                    'rr_confidence':        results.get('rr_confidence', 0),
                    'rr_classification':    _classify_respiratory_rate(results.get('rr', 0)),
                })
        else:
            web.session.metrics.update({
                'status':               'DISCONNECTED',
                'warnings':             ['No face detected'],
                'face_detected':        False,
            })
            
        _, buffer = cv2.imencode(".jpg", frame)
        annotated_b64 = base64.b64encode(buffer).decode('utf-8')
        
        return jsonify({
            'success': True,
            'annotated_image': f"data:image/jpeg;base64,{annotated_b64}",
            'metrics': web.session.metrics
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/chat', methods=['POST'])
def chat_api():
    data = request.json or {}
    user_message = data.get('message', '')
    history = data.get('history', [])
    image_data = data.get('image', None)  # Base64 data: "data:image/jpeg;base64,..."
    selected_patient_id = data.get('selected_patient_id', None)
    
    # Check if NVIDIA NIM key is present
    nvidia_key = os.getenv("NVIDIA_API_KEY")
    
    # Retrieve current active patient records from Neon
    patients = get_all_patients()
    
    # Check if user message explicitly matches any patient name in the database
    matched_patient = None
    for p in patients:
        p_name = str(p.get('name', '')).lower()
        if p_name and len(p_name) > 2 and p_name in user_message.lower():
            matched_patient = p
            break
            
    # Fallback to current selection if no explicit name was match in text
    if not matched_patient and selected_patient_id:
        matched_patient = next((p for p in patients if p.get('id') == selected_patient_id), None)

    patient_context = "\n\n=== CURRENT ACTIVE TRIAGE QUEUE & PATIENT RECORDS ===\n"
    if not patients:
        patient_context += "No patient records currently exist in the triage database.\n"
    else:
        for p in patients:
            patient_context += (
                f"- Patient Name: {p.get('name')}\n"
                f"  Record ID: {p.get('id')}\n"
                f"  Triage Timestamp: {p.get('timestamp')}\n"
                f"  Acuity Rating: ESI Level {p.get('esi_level')} (Priority Score: {p.get('priority_score')}/100)\n"
                f"  Vitals Telemetry: HR {p.get('heart_rate', '--')} BPM, Respiration {p.get('respiration', '--')} breaths/min, "
                f"HRV {p.get('hrv', '--')} ms, Stress Index {p.get('stress_index', '--')}\n"
                f"  Primary Diagnosis: {p.get('primary_diagnosis', 'N/A')}\n"
                f"  Shock Alert Criteria: {'CRITICAL / ACTIVE SHOCK' if p.get('is_shock') else 'NORMAL / NO SHOCK'}\n"
                f"  AI Clinical Assessment Trace: {p.get('triage_summary', 'N/A')}\n\n"
            )
            
    focused_context = ""
    if matched_patient:
        focused_context = (
            f"\n\n=== ACTIVE PATIENT CONTEXT FOCUS ===\n"
            f"The clinician is currently asking questions about or focusing on patient **{matched_patient['name']}**.\n"
            f"Record ID: {matched_patient['id']}\n"
            f"Triage Acuity: ESI Level {matched_patient['esi_level']} (Priority Score: {matched_patient['priority_score']}/100)\n"
            f"Active vitals: HR {matched_patient.get('heart_rate', '--')} BPM, Respiration {matched_patient.get('respiration', '--')} breaths/min, HRV {matched_patient.get('hrv', '--')} ms, Stress Index {matched_patient.get('stress_index', '--')}\n"
            f"Primary Diagnosis: {matched_patient.get('primary_diagnosis', 'N/A')}\n"
            f"Clinical Summary: {matched_patient.get('triage_summary', 'N/A')}\n"
            f"Treat any queries referencing pronouns ('he', 'she', 'they', 'this patient', 'the patient') as querying this patient.\n"
        )
            
    try:
        if nvidia_key:
            from langchain_nvidia_ai_endpoints import ChatNVIDIA
            from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
            
            # Setup messages list with system instructions and patient data injected
            instructions = (
                web.chatbot_sys_instruct + "\n\n"
                "CLINICAL DATABASE PRIVILEGES:\n"
                "You have read-only query access to the active patient database. Use the records listed below "
                "to answer questions from triage staff or patients about specific individuals. When asked about a "
                "patient by name, match it against the records, summarize their ESI score, vital statistics, "
                "and explain their triage significance. Remain highly professional and outline any warnings (e.g. shock risk).\n"
                + patient_context
                + focused_context
            )
            messages = [SystemMessage(content=instructions)]
            
            # Append historical messages
            for msg in history[-6:]:
                role = msg.get('role', 'user')
                content = msg.get('content', '')
                if role == 'user':
                    messages.append(HumanMessage(content=content))
                else:
                    messages.append(AIMessage(content=content))
            
            # Append new user message with optional image part for multimodal OCR
            if image_data:
                header, encoded = image_data.split(",", 1) if "," in image_data else ("", image_data)
                payload = [
                    {"type": "text", "text": user_message},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}}
                ]
                messages.append(HumanMessage(content=payload))
            else:
                messages.append(HumanMessage(content=user_message))
                
            primary_llm = ChatNVIDIA(
                model="meta/llama-3.1-8b-instruct",
                nvidia_api_key=nvidia_key
            )
            fallback_models = [
                ChatNVIDIA(model="meta/llama-3.3-70b-instruct", nvidia_api_key=nvidia_key),
                ChatNVIDIA(model="meta/llama-3.1-70b-instruct", nvidia_api_key=nvidia_key),
                ChatNVIDIA(model="qwen/qwen3.5-122b-a10b", nvidia_api_key=nvidia_key),
                ChatNVIDIA(model="abacusai/dracarys-llama-3.1-70b-instruct", nvidia_api_key=nvidia_key),
            ]
            chat_model = primary_llm.with_fallbacks(fallback_models)
            
            response = chat_model.invoke(messages)
            response_text = response.content
            
        else:
            # Fallback simulator with database parsing
            if matched_patient:
                response_text = (
                    f"[en-US] [DEMO MODE: DATABASE MATCHED] I found a matching record for patient **{matched_patient['name']}**.\n\n"
                    f"* **Triage Acuity:** ESI Level {matched_patient['esi_level']} (Score: {matched_patient['priority_score']}/100)\n"
                    f"* **Vitals:** HR {matched_patient.get('heart_rate', '--')} BPM, Respiration {matched_patient.get('respiration', '--')} breaths/min, HRV {matched_patient.get('hrv', '--')} ms, Stress Index {matched_patient.get('stress_index', '--')}\n"
                    f"* **Clinical Indication:** {matched_patient.get('primary_diagnosis', 'N/A')}\n"
                    f"* **AI Assessment:** {matched_patient.get('triage_summary', 'N/A')}\n\n"
                    f"To enable complete clinical reasoning on this record, please configure your NVIDIA_API_KEY."
                )
            else:
                if image_data:
                    response_text = (
                        "[en-US] [DEMO MODE: NVIDIA_API_KEY not set] I have successfully parsed your clinical document image. "
                        "The text indicates a patient intake chart with blood pressure 125/80 mmHg, resting heart rate 72 bpm, "
                        "and a chief complaint of mild chest tightness. These vitals map to ESI Level 3. "
                        "Please proceed with live sensor calibration or video upload for precise physiological analysis."
                    )
                else:
                    response_text = (
                        f"[en-US] [DEMO MODE: NVIDIA_API_KEY not set] Thank you for your clinical query. You asked: '{user_message}'. "
                        "ARIA is currently in fallback mode. Please configure NVIDIA_API_KEY in your .env to enable the full "
                        "NVIDIA Llama Nemotron reasoning engine."
                    )
                
        return jsonify({
            'response': response_text,
            'matched_patient_id': matched_patient.get('id') if matched_patient else None
        })
        
    except Exception as e:
        import traceback
        print("\n" + "!"*60)
        print(f"[CHAT ERROR] ARIA chatbot query failed: {str(e)}")
        traceback.print_exc()
        print("!"*60 + "\n")
        return jsonify({'error': f"ARIA query failed: {str(e)}"}), 500


@app.route('/api/generate_report', methods=['POST'])
def generate_report():
    """Generate a clinical session summary report from current rPPG metrics."""
    try:
        with web.session.processing_lock:
            metrics = dict(web.session.metrics)
            history = list(web.session.bpm_history)

        bpm = metrics.get('bpm', 0)
        rr  = metrics.get('rr', 0)
        hrv = metrics.get('hrv', web.session.last_valid_hrv or 0)
        stress = metrics.get('stress_index', web.session.last_valid_stress or 0)
        classification = metrics.get('classification', 'UNKNOWN')
        rr_classification = metrics.get('rr_classification', '--')
        confidence = metrics.get('confidence', 0)
        snr_db = metrics.get('snr_db', 0)
        status = metrics.get('status', 'UNKNOWN')
        lux = metrics.get('estimated_lux', 0)
        stability = metrics.get('stability_indicator', '--')

        # Session BPM statistics
        if len(history) >= 2:
            import statistics as _stats
            avg_bpm = round(_stats.mean(history), 1)
            min_bpm = round(min(history), 1)
            max_bpm = round(max(history), 1)
        elif bpm > 0:
            avg_bpm = min_bpm = max_bpm = round(float(bpm), 1)
        else:
            avg_bpm = min_bpm = max_bpm = None

        # Clinical interpretation
        if classification == 'NORMAL' and (rr_classification in ('NORMAL', '--')):
            clinical_summary = (
                f"Vitals within normal physiological range. "
                f"Heart rate {bpm} BPM classified as {classification}. "
                f"Respiratory rate {round(float(rr), 1) if rr else '--'} br/min. "
                f"HRV (RMSSD) {round(float(hrv), 1) if hrv else '--'} ms indicates "
                f"{'adequate autonomic balance' if hrv and float(hrv) > 20 else 'reduced autonomic variability'}."
            )
        elif classification == 'TACHYCARDIA':
            clinical_summary = (
                f"Elevated heart rate detected ({bpm} BPM — TACHYCARDIA). "
                f"Requires clinical assessment. Rule out fever, anxiety, dehydration, or cardiac arrhythmia. "
                f"HRV: {round(float(hrv), 1) if hrv else '--'} ms."
            )
        elif classification == 'BRADYCARDIA':
            clinical_summary = (
                f"Low heart rate detected ({bpm} BPM — BRADYCARDIA). "
                f"May indicate high athletic conditioning or AV conduction block. "
                f"Clinical evaluation advised. HRV: {round(float(hrv), 1) if hrv else '--'} ms."
            )
        else:
            clinical_summary = (
                f"Session vitals recorded. Signal confidence {confidence}%. "
                f"Further calibration or improved lighting may be needed for clinical-grade readings."
            )

        stress_label = (
            'CRITICAL' if float(stress or 0) > 150 else
            'ELEVATED' if float(stress or 0) > 80 else
            'OPTIMAL' if float(stress or 0) > 0 else 'UNKNOWN'
        )

        report = {
            'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'session_duration_s': 30,
            'vitals': {
                'heart_rate_bpm': bpm,
                'heart_rate_avg': avg_bpm,
                'heart_rate_min': min_bpm,
                'heart_rate_max': max_bpm,
                'classification': classification,
                'respiratory_rate': round(float(rr), 1) if rr else None,
                'rr_classification': rr_classification,
                'hrv_rmssd_ms': round(float(hrv), 1) if hrv else None,
                'stress_index': round(float(stress), 1) if stress else None,
                'stress_label': stress_label,
            },
            'signal_quality': {
                'confidence_pct': confidence,
                'snr_db': round(float(snr_db), 1) if snr_db else None,
                'stability': stability,
                'luminance_lux': lux,
                'status': status,
            },
            'clinical_summary': clinical_summary,
            'disclaimer': (
                'This report is generated by rPPG optical analysis and is intended as a screening aid only. '
                'It is NOT a substitute for clinical examination or certified medical diagnostics.'
            ),
        }

        web.session.last_compiled_report = report
        return jsonify({'success': True, 'report': report})

    except Exception as e:
        return jsonify({'success': False, 'error': f'Report generation failed: {str(e)}'}), 500




def extract_json(text):
    try:
        return json.loads(text)
    except Exception:
        pass
    
    # Try markdown json block
    match = re.search(r'```json\s*(.*?)\s*```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except Exception:
            pass
            
    # Try general JSON braces
    match = re.search(r'(\{.*\})', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except Exception:
            pass
            
    return None


@app.route('/api/triage_run', methods=['POST'])
def triage_run_api():
    """
    Kicks off the CrewAI 3-Agent pipeline on an uploaded video file OR the active live session.
    """
    patient_name = None
    # Support JSON POST request for live session
    if request.is_json:
        data = request.get_json(silent=True) or {}
        source = data.get('source', '')
        patient_name = data.get('patient_name', '')
        if source.lower() in ['live', 'webcam']:
            filepath = 'live'
        else:
            return jsonify({'error': 'Invalid source in JSON body. Expected "live" or "webcam".'}), 400
    else:
        patient_name = request.form.get('patient_name', '')
        if 'video' not in request.files:
            return jsonify({'error': 'No video file or JSON source parameter provided'}), 400
        file = request.files['video']
        if file.filename == '':
            return jsonify({'error': 'Invalid file'}), 400
        
        # Support sending "live" as filename
        if file.filename.lower() in ['live', 'webcam']:
            filepath = 'live'
        else:
            if not allowed_file(file.filename):
                return jsonify({'error': 'Invalid file type'}), 400
            filename = secure_filename(file.filename)
            filepath = os.path.join(app.root_path, '..', web.UPLOAD_FOLDER, filename)
            file.save(filepath)
    
    try:
        from agents.crew import triage_crew
        # Execute the 3-Agent Triage Crew
        crew_result = triage_crew.kickoff(inputs={"video_path": filepath})
        
        # Cast CrewOutput to string
        result_text = str(crew_result)
        
        # Parse ESI structured data from Coordinator Agent output
        esi_data = {
            'esi_level': 3,
            'priority_score': 50,
            'primary_diagnosis': 'General Assessment',
            'is_shock': False,
            'triage_summary': result_text[:300] + '...' if len(result_text) > 300 else result_text
        }
        
        parsed_json = extract_json(result_text)
        if parsed_json:
            if 'esi_level' in parsed_json:
                try:
                    esi_data['esi_level'] = int(parsed_json['esi_level'])
                except (ValueError, TypeError):
                    pass
            if 'priority_score' in parsed_json:
                try:
                    esi_data['priority_score'] = int(parsed_json['priority_score'])
                except (ValueError, TypeError):
                    pass
            if 'primary_diagnosis' in parsed_json:
                esi_data['primary_diagnosis'] = str(parsed_json['primary_diagnosis'])
            if 'is_shock' in parsed_json:
                esi_data['is_shock'] = bool(parsed_json['is_shock'])
            if 'triage_summary' in parsed_json:
                esi_data['triage_summary'] = str(parsed_json['triage_summary'])
                
        # Generate patient details
        import uuid
        patient_id = str(uuid.uuid4())[:8]
        if not patient_name or str(patient_name).strip() == '':
            patient_name = "Patient " + patient_id
            if filepath != 'live':
                base_name = os.path.basename(filepath)
                name_part = os.path.splitext(base_name)[0]
                patient_name = name_part.replace('_', ' ').replace('-', ' ').title()
            
        with web.session.processing_lock:
            cur_metrics = dict(web.session.metrics)

        patient_record = {
            'id': patient_id,
            'name': str(patient_name).strip(),
            'video_path': filepath,
            'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
            'esi_level': esi_data['esi_level'],
            'priority_score': esi_data['priority_score'],
            'primary_diagnosis': esi_data['primary_diagnosis'],
            'is_shock': esi_data['is_shock'],
            'triage_summary': esi_data['triage_summary'],
            'agent_output': result_text,
            'heart_rate': float(cur_metrics.get('bpm', 0)),
            'respiration': float(cur_metrics.get('rr', 0)),
            'hrv': float(cur_metrics.get('hrv', web.session.last_valid_hrv or 0)),
            'stress_index': float(cur_metrics.get('stress_index', web.session.last_valid_stress or 0))
        }
        
        # Save to Neon Postgres
        save_patient_record(patient_record)
        
        return jsonify({
            'success': True,
            'message': 'Multi-Agent Triage pipeline completed.',
            'patient_record': patient_record
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': f'CrewAI execution failed: {str(e)}'
        }), 500


@app.route('/api/triage_queue', methods=['GET', 'DELETE'])
def triage_queue_api():
    if request.method == 'DELETE':
        clear_all_patients()
        return jsonify({'success': True, 'message': 'Triage queue cleared.'})
        
    queue = get_all_patients()
    return jsonify({
        'success': True,
        'queue': queue
    })

