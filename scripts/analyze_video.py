#!/usr/bin/env python3
"""
Complete Video Analysis for Final Accurate Results
Processes entire video and returns final vital signs
"""
import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import cv2
import numpy as np
from core.rppg import AdvancedRPPG
from core.camera import Camera

def analyze_video_complete(video_path):
    """
    Analyze complete video and return final results
    
    Returns:
        dict with final BPM, confidence, and quality metrics
    """
    print(f"\n{'='*70}")
    print(f"ANALYZING: {video_path}")
    print(f"{'='*70}\n")
    
    # Initialize
    rppg = AdvancedRPPG(fps=30, window_size=300)
    camera = Camera(source=video_path)
    
    frame_count = 0
    bpm_readings = []
    
    print("Processing video frames...")
    
    # Process entire video
    while True:
        frame_bytes, roi_data, is_moving, motion_delta = camera.get_frame()
        
        if frame_bytes is None:
            break
            
        if roi_data is not None:
            avg_r, avg_g, avg_b = roi_data
            
            # Add to rPPG
            rppg.add_frame((avg_r, avg_g, avg_b))
            
            # Process with POS method
            result = rppg.process_ppg_signal()
            
            if result['ready'] and result['bpm'] > 0:
                bpm_readings.append({
                    'bpm': result['bpm'],
                    'confidence': result['confidence'],
                    'frame': frame_count
                })
        
        frame_count += 1
        if frame_count % 30 == 0:
            print(f"  ✓ Processed {frame_count} frames...")
    
    print(f"\n✓ Complete: {frame_count} frames analyzed\n")
    
    # Calculate final results
    if len(bpm_readings) > 0:
        # Use last 10 readings for final average (most stable)
        recent_readings = bpm_readings[-10:] if len(bpm_readings) >= 10 else bpm_readings
        
        final_bpm = np.mean([r['bpm'] for r in recent_readings])
        final_confidence = np.mean([r['confidence'] for r in recent_readings])
        stability = np.std([r['bpm'] for r in recent_readings])
        
        # Get signal quality
        quality = rppg.get_signal_quality()
        
        return {
            'success': True,
            'bpm': round(final_bpm, 1),
            'confidence': round(final_confidence, 1),
            'stability': round(stability, 1),
            'quality': round(quality, 1),
            'frames_analyzed': frame_count,
            'valid_readings': len(bpm_readings),
            'mode': 'FACE'
        }
    else:
        return {
            'success': False,
            'error': 'No valid BPM readings detected',
            'frames_analyzed': frame_count
        }


if __name__ == '__main__':
    video_path = sys.argv[1] if len(sys.argv) > 1 else 'uploads/face.mp4'
    
    results = analyze_video_complete(video_path)
    
    print(f"{'='*70}")
    print("FINAL RESULTS")
    print(f"{'='*70}\n")
    
    if results['success']:
        print(f"🫀 HEART RATE: {results['bpm']} BPM")
        print(f"📊 CONFIDENCE: {results['confidence']}%")
        print(f"📈 STABILITY: ±{results['stability']} BPM")
        print(f"✨ SIGNAL QUALITY: {results['quality']}%")
        print(f"\n📹 Frames Analyzed: {results['frames_analyzed']}")
        print(f"✅ Valid Readings: {results['valid_readings']}")
        
        # Health assessment
        bpm = results['bpm']
        if 60 <= bpm <= 100:
            print(f"\n💚 STATUS: NORMAL (Resting heart rate)")
        elif bpm < 60:
            print(f"\n💙 STATUS: BRADYCARDIA (Low heart rate)")
        else:
            print(f"\n❤️  STATUS: TACHYCARDIA (Elevated heart rate)")
    else:
        print(f"❌ ERROR: {results['error']}")
        print(f"   Frames analyzed: {results['frames_analyzed']}")
    
    print(f"\n{'='*70}\n")
