#tools.py
from crewai.tools import tool
from scripts.analyze_video import analyze_video_complete

@tool("Vitals Extraction Tool")
def extract_vitals(video_path: str) -> str:
    """
    Extracts physiological vitals (BPM, Respiratory Rate, HRV, and Stress Index)
    from a pre-recorded patient video file (e.g., 'uploads/face.mp4') OR from the active live webcam session
    if video_path is set to 'live' or 'webcam'.
    
    Args:
        video_path (str): Path to patient video file, OR 'live'/'webcam' for active session.
        
    Returns:
        str: A stringified dictionary containing the extracted metrics.
    """
    if video_path.lower() in ["live", "webcam"]:
        try:
            # Import web locally to prevent circular dependencies
            import web
            with web.session.processing_lock:
                metrics = dict(web.session.metrics)
                history = list(web.session.bpm_history)
                last_report = web.session.last_compiled_report
            
            if not history and metrics.get('status') == 'WAITING':
                if last_report:
                    results = {
                        'success': True,
                        'bpm': last_report['vitals']['heart_rate_bpm'] or last_report['vitals']['heart_rate_avg'] or 0.0,
                        'confidence': last_report['signal_quality']['confidence_pct'],
                        'stability': 50.0,
                        'rr': last_report['vitals']['respiratory_rate'] or 0.0,
                        'hrv': last_report['vitals']['hrv_rmssd_ms'] or 0.0,
                        'stress_index': last_report['vitals']['stress_index'] or 0.0,
                        'estimated_lux': last_report['signal_quality']['luminance_lux'],
                        'motion_delta': 0,
                        'mode': 'WEBCAM_COMPLETED_SESSION'
                    }
                    return str(results)
                return "Error: No active live webcam session data or completed report found. Start a webcam session first."
            
            import statistics as stats
            if len(history) >= 2:
                avg_bpm = stats.mean(history)
            elif len(history) == 1:
                avg_bpm = history[0]
            else:
                avg_bpm = metrics.get('bpm', 0)
                
            results = {
                'success': True,
                'bpm': round(avg_bpm, 1),
                'confidence': metrics.get('confidence', 0),
                'stability': metrics.get('stability', 0),
                'rr': metrics.get('rr', 0),
                'hrv': metrics.get('hrv', 0),
                'stress_index': metrics.get('stress_index', 0),
                'estimated_lux': metrics.get('estimated_lux', 0),
                'motion_delta': metrics.get('motion_delta', 0),
                'mode': 'WEBCAM'
            }
            return str(results)
        except Exception as e:
            return f"Error reading live webcam session data: {str(e)}"

    try:
        results = analyze_video_complete(video_path)
        return str(results)
    except Exception as e:
        return f"Error executing vitals extraction: {str(e)}"
