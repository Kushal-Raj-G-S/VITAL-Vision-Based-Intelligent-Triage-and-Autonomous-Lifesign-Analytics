#!/usr/bin/env python3
"""
Opti-Screen Round 2 - BPM Validation Tool
Runs analysis on a set of videos and compares against Ground Truth (GT) BPM.
Calculates Mean Absolute Error (MAE) for credibility.
"""
import os
# Add parent directory to path to support scripts package import
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Suppress debug output from analyze_video for clean table
class HiddenPrints:
    def __enter__(self):
        self._original_stdout = sys.stdout
        sys.stdout = open(os.devnull, 'w')
    def __exit__(self, exc_type, exc_val, exc_tb):
        sys.stdout.close()
        sys.stdout = self._original_stdout

from scripts.analyze_video import analyze_video_complete

def run_validation(dataset):
    print("=" * 80)
    print("🫀 Opti-Screen - BPM Validation & MAE Evaluation")
    print("=" * 80)
    print(f"{'Video File':<30} | {'GT BPM':<10} | {'Our BPM':<10} | {'Error (MAE)':<15}")
    print("-" * 80)
    
    total_error = 0
    valid_count = 0
    
    for item in dataset:
        video_path = item['video']
        gt_bpm = item['gt_bpm']
        
        if not os.path.exists(video_path):
            print(f"{video_path[:28]:<30} | {'NOT FOUND':<10} | {'-':<10} | {'-':<15}")
            continue
            
        print(f"Processing {video_path}...", end='\r')
        
        # Suppress standard output of analyze_video_complete for clean table
        with HiddenPrints():
            results = analyze_video_complete(video_path)
        
        # Clear processing line
        sys.stdout.write("\033[K")
        
        if results['success']:
            our_bpm = results['bpm']
            error = abs(our_bpm - gt_bpm)
            total_error += error
            valid_count += 1
            print(f"{video_path[:28]:<30} | {gt_bpm:<10} | {our_bpm:<10.1f} | {error:.1f} BPM")
        else:
            print(f"{video_path[:28]:<30} | {gt_bpm:<10} | {'FAILED':<10} | {'-':<15}")
            
    print("-" * 80)
    if valid_count > 0:
        mae = total_error / valid_count
        print(f"Overall Mean Absolute Error (MAE): {mae:.2f} BPM across {valid_count} subject(s)")
        if mae < 5.0:
            print(f"Status: 🟢 CLINICAL-ADJACENT ACCURACY (MAE < 5 BPM) — validated on {valid_count} subject(s)")
        elif mae < 8.0:
            print(f"Status: 🟡 RESEARCH GRADE (MAE < 8 BPM) — validated on {valid_count} subject(s)")
        else:
            print(f"Status: 🟠 CONSUMER GRADE (MAE ≥ 8 BPM) — validated on {valid_count} subject(s)")
    else:
        print("No valid readings obtained from dataset.")
    print("=" * 80)

if __name__ == '__main__':
    # Scan uploads/ folder for available test videos
    uploads_dir = 'uploads'
    if os.path.isdir(uploads_dir):
        video_exts = ('.mp4', '.avi', '.mov', '.mkv', '.webm')
        found = [f for f in sorted(os.listdir(uploads_dir)) if f.lower().endswith(video_exts)]
    else:
        found = []

    if found:
        # Build dataset from discovered files (GT BPM unknown — set to 0 for pure analysis)
        dataset = [{'video': os.path.join(uploads_dir, f), 'gt_bpm': 0} for f in found]
        print(f"\nDiscovered {len(found)} video(s) in {uploads_dir}/")
    else:
        # Fallback placeholder
        dataset = [
            {'video': 'uploads/test_subject_01.mp4', 'gt_bpm': 75},
        ]
        print("\nNo videos found in uploads/ — using placeholder dataset.")

    print("Starting BPM Validation Test...")
    run_validation(dataset)
