'use client';

import React, { useState, useEffect, useRef } from 'react';

// TypeScript Interfaces
interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  image?: string; // Base64 encoding of clinical image
}

interface PatientRecord {
  id: string;
  name: string;
  video_path: string;
  timestamp: string;
  esi_level: number;
  priority_score: number;
  primary_diagnosis: string;
  is_shock: boolean;
  triage_summary: string;
  agent_output: string;
  heart_rate?: number;
  respiration?: number;
  hrv?: number;
  stress_index?: number;
}

interface CameraDevice {
  index: number;
  label: string;
}

interface Metrics {
  bpm: number;
  confidence: number;
  status: string;
  snr_db: number;
  sqi: number;
  classification: string;
  ohi: number;
  stability: number;
  stability_indicator: string;
  rr: number;
  rr_confidence: number;
  rr_classification: string;
  hrv: number;
  stress_index: number;
  warnings: string[];
  remark: string;
  estimated_lux: number;
  motion_delta: number;
  is_live: boolean;
  calibration_done: boolean;
  ppg_signal: number[];
  calibration_progress: number;
  face_detected?: boolean;
}

type NavigationTab = 'monitor' | 'queue' | 'crew' | 'chat';

export default function Home() {
  const BACKEND_URL = typeof window !== 'undefined' 
    ? `http://${window.location.hostname}:5002` 
    : "http://127.0.0.1:5002";

  console.log("[VITAL] Home component rendered! BACKEND_URL is:", BACKEND_URL);

  // Navigation & Layout states
  const [activeTab, setActiveTab] = useState<NavigationTab>('monitor');
  const [sidebarExpanded, setSidebarExpanded] = useState<boolean>(true);
  const [speakingMessageIdx, setSpeakingMessageIdx] = useState<number | null>(null);

  // Connection and settings state
  const [backendOnline, setBackendOnline] = useState<boolean>(false);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null);
  
  // Real-time metric states
  const [metrics, setMetrics] = useState<Metrics>({
    bpm: 0, confidence: 0, status: 'DISCONNECTED',
    snr_db: 0, sqi: 0, classification: 'UNKNOWN',
    ohi: 0, stability: 0, stability_indicator: '--',
    rr: 0, rr_confidence: 0, rr_classification: '--',
    hrv: 0, stress_index: 0, warnings: [],
    remark: '', estimated_lux: 0, motion_delta: 0,
    is_live: false, calibration_done: false, ppg_signal: [],
    calibration_progress: 0, face_detected: false
  });
  
  // Triage Queue & Multi-Agent Triage state
  const [triageQueue, setTriageQueue] = useState<PatientRecord[]>([]);
  const [isTriageRunning, setIsTriageRunning] = useState<boolean>(false);
  const [lastTriageResult, setLastTriageResult] = useState<PatientRecord | null>(null);
  const [selectedConsultPatientId, setSelectedConsultPatientId] = useState<string | null>(null);
  const [activeAgentTab, setActiveAgentTab] = useState<'perception' | 'diagnostic' | 'coordinator'>('perception');
  
  // Chat state
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  
  // File upload state
  const [uploadMessage, setUploadMessage] = useState<{ text: string; type: 'success' | 'error' | '' }>({ text: '', type: '' });
  // Video feed reconnection key — incrementing forces img src reload
  const [videoFeedKey, setVideoFeedKey] = useState<number>(0);
  // 30-second session timer and auto-report
  const [sessionTimer, setSessionTimer] = useState<number>(30);
  const [sessionReport, setSessionReport] = useState<any>(null);
  const [reportLoading, setReportLoading] = useState<boolean>(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const reportFetchedRef = useRef<boolean>(false);
  
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [patientName, setPatientName] = useState<string>('');
  
  // Refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const sessionStartedRef = useRef<boolean>(false); // Prevent double auto-start
  
  // Polling intervals
  const statusPollInterval = useRef<NodeJS.Timeout | null>(null);

  // Client-side browser camera streaming references
  const [browserAnnotatedFrame, setBrowserAnnotatedFrame] = useState<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamLoopRef = useRef<any>(null);

  // 1. Verify Backend Online and fetch cameras & queue
  const checkBackendStatus = async () => {
    console.log("[VITAL] Attempting backend status check to:", `${BACKEND_URL}/api/cameras`);
    try {
      const res = await fetch(`${BACKEND_URL}/api/cameras`);
      if (res.ok) {
        setBackendOnline(true);
        const data = await res.json();
        const serverCams = data.cameras || [];
        const browserCam: CameraDevice = { index: -99, label: "💻 Client Browser Webcam" };
        setCameras([browserCam, ...serverCams]);
        if (data.default !== null && data.default !== undefined) {
          setSelectedCamera((prev) => prev !== null ? prev : -99);
        }
        fetchQueue();
      } else {
        console.warn("[VITAL] Status check failed. Server returned status:", res.status);
        setBackendOnline(false);
        sessionStartedRef.current = false; // backend went offline, allow re-start
      }
    } catch (e) {
      console.error("[VITAL] Connection failed. Check CORS, firewalls, or server state:", e);
      setBackendOnline(false);
      sessionStartedRef.current = false;
    }
  };

  const fetchQueue = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/triage_queue`);
      if (res.ok) {
        const data = await res.json();
        setTriageQueue(data.queue || []);
      }
    } catch (e) {
      console.error("Error fetching triage queue:", e);
    }
  };

  useEffect(() => {
    checkBackendStatus();
    const interval = setInterval(checkBackendStatus, 5000);
    
    // Warm up speech synthesis voices list early on mount
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.getVoices();
        };
      }
    }
    
    return () => clearInterval(interval);
  }, []);

  // Set up status polling
  useEffect(() => {
    if (backendOnline) {
      statusPollInterval.current = setInterval(async () => {
        try {
          const res = await fetch(`${BACKEND_URL}/status`);
          if (res.ok) {
            const data = await res.json();
            setMetrics(data);
          }
        } catch (e) {
          console.error("Status poll error:", e);
        }
      }, 300);
    } else {
      if (statusPollInterval.current) clearInterval(statusPollInterval.current);
    }
    return () => {
      if (statusPollInterval.current) clearInterval(statusPollInterval.current);
    };
  }, [backendOnline]);

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, isChatLoading, activeTab]);

  // 30-second countdown timer — starts when calibration_done flips true
  useEffect(() => {
    if (metrics.calibration_done && metrics.is_live) {
      // Start countdown if not already running
      if (timerRef.current === null && sessionTimer <= 30 && !reportFetchedRef.current) {
        timerRef.current = setInterval(() => {
          setSessionTimer(prev => {
            if (prev <= 1) {
              // Time up — fetch report
              clearInterval(timerRef.current!);
              timerRef.current = null;
              if (!reportFetchedRef.current) {
                reportFetchedRef.current = true;
                setReportLoading(true);
                fetch(`${BACKEND_URL}/api/generate_report`, { method: 'POST' })
                  .then(r => r.json())
                  .then(d => { 
                    if (d.success) {
                      setSessionReport(d.report);
                      // Auto-run Clinical Crew triage with custom patient name
                      handleRunTriage(patientName);
                    }
                  })
                  .catch(console.error)
                  .finally(() => setReportLoading(false));
              }
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      }
    } else {
      // Reset on disconnect / new session
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (!metrics.calibration_done) {
        setSessionTimer(30);
        setSessionReport(null);
        reportFetchedRef.current = false;
      }
    }
    return () => {};
  }, [metrics.calibration_done, metrics.is_live, sessionReport]);

  // 2. Draw rPPG wave signal on HTML5 Canvas
  useEffect(() => {
    if (activeTab !== 'monitor') return; // Draw only when visible
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw background grid
    ctx.strokeStyle = theme === 'light' ? 'rgba(15, 23, 42, 0.03)' : 'rgba(255, 255, 255, 0.02)';
    ctx.lineWidth = 1;
    for (let i = 0; i < canvas.width; i += 40) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, canvas.height);
      ctx.stroke();
    }
    for (let i = 0; i < canvas.height; i += 30) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(canvas.width, i);
      ctx.stroke();
    }

    const signal = metrics.ppg_signal || [];
    if (signal.length === 0) {
      // Draw idle scanning line
      ctx.strokeStyle = theme === 'light' ? 'rgba(15, 23, 42, 0.15)' : 'rgba(56, 189, 248, 0.2)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
      return;
    }

    // Smooth signal mapping
    const maxVal = Math.max(...signal);
    const minVal = Math.min(...signal);
    const range = maxVal - minVal || 1;

    // Shaded gradient area under the curve
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    for (let i = 0; i < signal.length; i++) {
      const x = (i / (signal.length - 1)) * canvas.width;
      const y = canvas.height - 20 - ((signal[i] - minVal) / range) * (canvas.height - 40);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();
    
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (theme === 'light') {
      grad.addColorStop(0, 'rgba(8, 145, 178, 0.15)');
      grad.addColorStop(1, 'rgba(8, 145, 178, 0.00)');
    } else {
      grad.addColorStop(0, 'rgba(56, 189, 248, 0.12)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0.00)');
    }
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw the neon stroke line
    ctx.beginPath();
    ctx.strokeStyle = theme === 'light' ? 'rgba(8, 145, 178, 0.9)' : 'rgba(56, 189, 248, 0.95)';
    ctx.lineWidth = 2.5;
    if (theme !== 'light') {
      ctx.shadowBlur = 10;
      ctx.shadowColor = 'rgba(56, 189, 248, 0.5)';
    }

    for (let i = 0; i < signal.length; i++) {
      const x = (i / (signal.length - 1)) * canvas.width;
      const y = canvas.height - 20 - ((signal[i] - minVal) / range) * (canvas.height - 40);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0; // reset
  }, [metrics.ppg_signal, metrics.status, activeTab, theme]);

  // 3. Audio Recording STT / Voice Input
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const rec = new SpeechRecognition();
        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = 'en-US';

        rec.onstart = () => setIsRecording(true);
        rec.onend = () => setIsRecording(false);
        rec.onerror = () => setIsRecording(false);
        rec.onresult = (event: any) => {
          const resultText = event.results[0][0].transcript;
          setChatInput(resultText);
        };
        recognitionRef.current = rec;
      }
    }
  }, []);

  const toggleRecording = () => {
    if (!recognitionRef.current) {
      alert("Speech Recognition API is not supported in this browser. Please type your query.");
      return;
    }
    if (isRecording) {
      recognitionRef.current.stop();
    } else {
      recognitionRef.current.start();
    }
  };

  // 4. Voice TTS output (with manual play/stop toggle)
  const speakText = (text: string, index: number) => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      if (window.speechSynthesis.speaking && speakingMessageIdx === index) {
        window.speechSynthesis.cancel();
        setSpeakingMessageIdx(null);
        return;
      }
      
      window.speechSynthesis.cancel();
      
      // Remove any brackets/metadata tags before reading
      const cleanMsg = text.replace(/^\[[a-z]{2}-[A-Z]{2}\]\s*/i, '')
                           .replace(/[*#`_]/g, ''); // Clean markdown characters
                           
      const utterance = new SpeechSynthesisUtterance(cleanMsg);
      
      // Attempt to load premium clinical voice (prioritizing high-fidelity English female voices)
      const voices = window.speechSynthesis.getVoices();
      
      // Filter English voices and strictly exclude known male voice identifiers
      const enVoices = voices.filter(v => {
        const name = v.name.toLowerCase();
        const lang = v.lang.toLowerCase();
        return lang.startsWith('en') && 
               !name.includes('david') && 
               !name.includes('male') && 
               !name.includes('george') &&
               !name.includes('richard') &&
               !name.includes('mark') &&
               !name.includes('harish') &&
               !name.includes('ravi');
      });

      // Find the most natural/human-sounding English female voice from the filtered list
      const femaleVoice = enVoices.find(v => {
        const name = v.name.toLowerCase();
        return name.includes('natural') || 
               name.includes('online') || 
               name.includes('google us english') || 
               name.includes('jenny') || 
               name.includes('aria') || 
               name.includes('samantha') || 
               name.includes('karen') ||
               name.includes('zira') ||
               name.includes('female');
      }) || enVoices[0] || voices.find(v => v.lang.startsWith('en')) || voices[0];
      
      if (femaleVoice) {
        utterance.voice = femaleVoice;
      }
      utterance.rate = 1.2;  // Brisk, clinical speech rate
      utterance.pitch = 1.0; // Standard pitch (prevents robotic synthetic squeaking)
      
      utterance.onend = () => {
        setSpeakingMessageIdx(null);
      };
      utterance.onerror = () => {
        setSpeakingMessageIdx(null);
      };
      
      setSpeakingMessageIdx(index);
      window.speechSynthesis.speak(utterance);
    }
  };

  // 5. Handlers
  const handleStartWebcam = async () => {
    setUploadMessage({ text: '', type: '' });
    
    // Check if client browser camera is selected
    if (selectedCamera === -99) {
      try {
        if (streamLoopRef.current) {
          clearInterval(streamLoopRef.current);
          streamLoopRef.current = null;
        }
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(t => t.stop());
          localStreamRef.current = null;
        }
        
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, frameRate: 30 }
        });
        localStreamRef.current = stream;
        
        if (!localVideoRef.current) {
          localVideoRef.current = document.createElement('video');
          localVideoRef.current.autoplay = true;
          localVideoRef.current.playsInline = true;
        }
        localVideoRef.current.srcObject = stream;
        await localVideoRef.current.play();
        
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');
        
        const loop = setInterval(async () => {
          if (!localVideoRef.current || !localStreamRef.current || !ctx) return;
          ctx.drawImage(localVideoRef.current, 0, 0, 640, 480);
          const base64Img = canvas.toDataURL('image/jpeg', 0.7);
          
          try {
            const res = await fetch(`${BACKEND_URL}/api/stream_frame`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: base64Img })
            });
            const frameData = await res.json();
            if (frameData.success) {
              setBrowserAnnotatedFrame(frameData.annotated_image);
              setMetrics(frameData.metrics);
            }
          } catch (err) {
            console.error("Browser webcam frame upload error:", err);
          }
        }, 70); // ~14 FPS is ideal to prevent network lag while keeping rPPG signal smooth
        
        streamLoopRef.current = loop;
        setMetrics(m => ({ ...m, is_live: true, status: 'CALIBRATING', calibration_progress: 0 }));
        setUploadMessage({ text: 'Client browser webcam streaming active.', type: 'success' });
      } catch (err: any) {
        console.error("Error starting browser webcam stream:", err);
        setUploadMessage({ text: `Camera access failed: ${err.message || err}`, type: 'error' });
      }
      return;
    }

    try {
      const res = await fetch(`${BACKEND_URL}/start_webcam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: selectedCamera })
      });
      const data = await res.json();
      if (data.success) {
        setUploadMessage({ text: `Webcam session initialized.`, type: 'success' });
        // Force video feed img to reconnect (backend reset kills old MJPEG stream)
        setTimeout(() => setVideoFeedKey(k => k + 1), 400);
      } else {
        setUploadMessage({ text: data.error || 'Failed to start webcam.', type: 'error' });
      }
    } catch (e) {
      setUploadMessage({ text: 'Error starting webcam.', type: 'error' });
    }
  };

  const handleReleaseCamera = async () => {
    // Clear local client webcam loops if active
    if (streamLoopRef.current) {
      clearInterval(streamLoopRef.current);
      streamLoopRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    setBrowserAnnotatedFrame(null);
    setMetrics(m => ({ ...m, is_live: false, status: 'DISCONNECTED' }));

    try {
      await fetch(`${BACKEND_URL}/release_camera`, { method: 'POST' });
      setUploadMessage({ text: 'Optical hardware released.', type: 'success' });
    } catch (e) {
      console.error(e);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];

    const formData = new FormData();
    formData.append('video', file);

    setUploadMessage({ text: 'Uploading intake media record...', type: 'success' });

    try {
      const res = await fetch(`${BACKEND_URL}/upload`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        setUploadMessage({ text: `Media loaded: ${data.message}`, type: 'success' });
      } else {
        setUploadMessage({ text: data.error || 'Upload failed.', type: 'error' });
      }
    } catch (err) {
      setUploadMessage({ text: 'Network error uploading file.', type: 'error' });
    }
  };

  const handleImageAttachment = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    
    const reader = new FileReader();
    reader.onloadend = () => {
      setSelectedImage(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleRunTriage = async (customName?: string) => {
    setIsTriageRunning(true);
    setLastTriageResult(null);
    try {
      const isLive = metrics.is_live || (metrics.status === 'OK' || metrics.status === 'CALIBRATING');
      const bodySource = isLive ? 'live' : '';
      const nameToSubmit = customName || patientName || '';
      
      let res;
      if (bodySource) {
        res = await fetch(`${BACKEND_URL}/api/triage_run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'live', patient_name: nameToSubmit })
        });
      } else {
        const formData = new FormData();
        formData.append('patient_name', nameToSubmit);
        res = await fetch(`${BACKEND_URL}/api/triage_run`, {
          method: 'POST',
          body: formData
        });
      }

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setLastTriageResult(data.patient_record);
          fetchQueue();
          setActiveAgentTab('coordinator');
        } else {
          alert(`Triage Crew failed: ${data.error}`);
        }
      } else {
        alert("Server error running Triage Crew.");
      }
    } catch (e) {
      alert(`Network error running Triage Crew: ${e}`);
    } finally {
      setIsTriageRunning(false);
    }
  };

  const handleClearQueue = async () => {
    if (!confirm("Are you sure you want to clear the entire triage queue?")) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/triage_queue`, { method: 'DELETE' });
      if (res.ok) {
        fetchQueue();
        setLastTriageResult(null);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() && !selectedImage) return;

    const userMsg: ChatMessage = { 
      role: 'user', 
      content: chatInput,
      image: selectedImage || undefined
    };

    // Client-side instant match for patient name in clinician input query
    const textToSearch = chatInput.toLowerCase().trim();
    const matched = triageQueue.find(p => {
      const pName = p.name.toLowerCase().trim();
      return pName.length > 2 && textToSearch.includes(pName);
    });
    if (matched) {
      setSelectedConsultPatientId(matched.id);
    }
    
    const updatedHistory = [...chatHistory, userMsg];
    setChatHistory(updatedHistory);
    setChatInput('');
    setSelectedImage(null);
    setIsChatLoading(true);

    try {
      const res = await fetch(`${BACKEND_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: userMsg.content, 
          history: chatHistory.map(m => ({ role: m.role, content: m.content })),
          image: userMsg.image,
          selected_patient_id: selectedConsultPatientId
        })
      });
      const data = await res.json();
      if (data.response) {
        const modelMsg: ChatMessage = { role: 'model', content: data.response };
        setChatHistory([...updatedHistory, modelMsg]);
        if (data.matched_patient_id) {
          setSelectedConsultPatientId(data.matched_patient_id);
          await fetchQueue();
        }
      } else {
        setChatHistory([...updatedHistory, { role: 'model', content: `Error: ${data.error || 'No response.'}` }]);
      }
    } catch (e) {
      setChatHistory([...updatedHistory, { role: 'model', content: 'Connection error connecting to ARIA.' }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  // UI Helpers
  const getEsiClass = (level: number) => {
    switch (level) {
      case 1: return 'bg-red-500/10 border-red-500/30 text-red-500 shadow-[0_0_12px_rgba(239,68,68,0.1)] animate-pulse';
      case 2: return 'bg-orange-500/10 border-orange-500/30 text-orange-500';
      case 3: return 'bg-yellow-500/10 border-yellow-500/30 text-yellow-500';
      case 4: return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500';
      case 5: return 'bg-cyan-500/10 border-cyan-500/30 text-cyan-500';
      default: return 'bg-zinc-800 border-zinc-700 text-zinc-300';
    }
  };

  const getHeartbeatDuration = () => {
    const rate = metrics.bpm > 0 ? metrics.bpm : 72;
    return `${60 / rate}s`;
  };

  return (
    <div className={`flex min-h-screen bg-panel-bg text-text-primary transition-colors duration-300 ${
      theme === 'light' ? 'light' : ''
    }`}>
      
      {/* 1. Left Collapsible Sidebar Panel */}
      <aside className={`h-screen sticky top-0 border-r border-panel-border bg-panel-card backdrop-blur-xl flex flex-col justify-between p-4 transition-all duration-500 ease-in-out shrink-0 z-50 ${
        sidebarExpanded ? 'w-64' : 'w-20'
      }`}>
        
        {/* Top Section */}
        <div className="flex flex-col gap-6">
          {/* Logo & Expand Toggle Stack */}
          <div className="flex flex-col gap-4 items-center w-full">
            <div className="flex items-center justify-between w-full min-w-0">
              <div className="flex items-center min-w-0">
                <div className="w-10 h-10 rounded-xl bg-slate-900/10 border border-panel-border flex items-center justify-center shadow-sm overflow-hidden shrink-0">
                  <img src="/vital_logo.png" alt="VITAL Logo" className="w-full h-full object-cover" />
                </div>
                <div className={`transition-all duration-500 ease-in-out overflow-hidden flex flex-col whitespace-nowrap ${
                  sidebarExpanded ? 'max-w-[120px] opacity-100 ml-3' : 'max-w-0 opacity-0 ml-0'
                }`}>
                  <h1 className="text-base font-black tracking-tight text-text-primary leading-none">VITAL</h1>
                  <span className="text-[8px] text-text-secondary uppercase tracking-widest font-black block mt-0.5">Intelligent Triage</span>
                </div>
              </div>
              
              {/* Theme toggle when expanded */}
              {sidebarExpanded && (
                <button
                  onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
                  className="flex items-center justify-center p-2 bg-panel-bg border border-panel-border rounded-xl text-text-secondary hover:text-text-primary transition-all shadow-sm shrink-0"
                  title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
                >
                  {theme === 'dark' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-amber-400">
                      <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent-indigo">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                    </svg>
                  )}
                </button>
              )}
            </div>

            {/* Theme toggle when collapsed (moves below logo) */}
            {!sidebarExpanded && (
              <button
                onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
                className="flex items-center justify-center p-2 bg-panel-bg border border-panel-border rounded-xl text-text-secondary hover:text-text-primary transition-all shadow-sm w-10 h-10 shrink-0"
                title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
              >
                {theme === 'dark' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-amber-400">
                    <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent-indigo">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                )}
              </button>
            )}
          </div>
          
          {/* Collapse/Expand Sidebar Handle Button */}
          <button
            onClick={() => setSidebarExpanded(!sidebarExpanded)}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-3 bg-panel-bg border border-panel-border hover:border-text-secondary/20 rounded-xl text-[10px] font-black uppercase tracking-wider text-text-secondary hover:text-text-primary transition-all duration-300 shadow-sm shrink-0"
            title={sidebarExpanded ? "Collapse Sidebar" : "Expand Sidebar"}
          >
            {sidebarExpanded ? (
              <>
                <span>◀</span>
                <span>Collapse Menu</span>
              </>
            ) : (
              <span>▶</span>
            )}
          </button>

          {/* Navigation List */}
          <nav className="flex flex-col gap-1.5 mt-2">
            {[
              { id: 'monitor', label: 'Vitals Monitor', icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
              { id: 'queue', label: 'Triage Dispatch', icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>, count: triageQueue.length },
              { id: 'crew', label: 'Clinical Crew', icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg> },
              { id: 'chat', label: 'Clinical Consult', icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>, isAria: true }
            ].map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id as NavigationTab)}
                  className={`w-full py-3 px-3.5 rounded-xl flex items-center transition-all duration-300 text-xs font-black uppercase tracking-wider relative ${
                    isActive 
                      ? 'bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20 shadow-[0_0_15px_var(--panel-border-glow)]'
                      : 'text-text-secondary hover:text-text-primary border border-transparent hover:bg-panel-bg/40'
                  }`}
                  title={item.label}
                >
                  <div className="w-5 h-5 flex items-center justify-center shrink-0">
                    {item.icon}
                  </div>
                  <span className={`transition-all duration-500 ease-in-out overflow-hidden whitespace-nowrap text-left font-black tracking-wider ${
                    sidebarExpanded ? 'max-w-[150px] opacity-100 ml-3' : 'max-w-0 opacity-0 ml-0'
                  }`}>
                    {item.label}
                  </span>
                  
                  {item.count !== undefined && item.count > 0 && (
                    <span className={`absolute leading-none font-bold rounded-full transition-all duration-300 ${
                      sidebarExpanded 
                        ? 'right-3 px-1.5 py-0.5 text-[9px] bg-accent-cyan text-slate-950 font-black' 
                        : 'top-1 right-1 w-4 h-4 text-[8px] bg-accent-cyan text-slate-950 flex items-center justify-center font-black'
                    }`}>
                      {item.count}
                    </span>
                  )}
                  {item.isAria && !sidebarExpanded && (
                    <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse"></span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Section */}
        <div className="flex flex-col gap-4 border-t border-panel-border/40 pt-4 w-full">
          {/* Active queue count summary */}
          <div className="w-full">
            <div className={`transition-all duration-500 ease-in-out overflow-hidden flex flex-col ${
              sidebarExpanded ? 'max-h-[80px] opacity-100' : 'max-h-0 opacity-0 pointer-events-none'
            }`}>
              <div className="bg-panel-bg border border-panel-border rounded-xl p-3 shadow-sm text-center">
                <div className="text-[8px] text-text-secondary uppercase tracking-widest font-black">Active Triage Cases</div>
                <div className="text-sm font-black font-mono text-accent-cyan mt-0.5">{triageQueue.length} Active</div>
              </div>
            </div>
            {!sidebarExpanded && (
              <div className="flex justify-center transition-all duration-500" title={`${triageQueue.length} Patients in Queue`}>
                <span className="w-8 h-8 rounded-full bg-panel-bg border border-panel-border flex items-center justify-center text-xs font-black text-accent-cyan shadow-sm font-mono">
                  {triageQueue.length}
                </span>
              </div>
            )}
          </div>

          {/* Telemetry Status Indicator */}
          <div className="w-full">
            <div className={`transition-all duration-500 ease-in-out overflow-hidden ${
              sidebarExpanded ? 'max-h-[50px] opacity-100' : 'max-h-0 opacity-0 pointer-events-none'
            }`}>
              <div className="flex items-center justify-between text-[9px] font-black uppercase tracking-wider bg-panel-bg border border-panel-border rounded-xl p-3 shadow-sm">
                <span className="text-text-secondary">System Online</span>
                {backendOnline ? (
                  <span className="flex items-center gap-1.5 text-emerald-500 font-extrabold">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
                    LIVE
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-rose-500 font-extrabold">
                    <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                    OFFLINE
                  </span>
                )}
              </div>
            </div>
            {!sidebarExpanded && (
              <div className="flex justify-center transition-all duration-500 py-1" title={backendOnline ? "System Online: LIVE" : "System Offline"}>
                <span className={`w-3.5 h-3.5 rounded-full flex items-center justify-center transition-all ${
                  backendOnline 
                    ? 'bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]' 
                    : 'bg-rose-500'
                }`}></span>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* 2. Right-Side Workspace Container */}
      <main className="flex-1 min-h-screen p-8 flex flex-col justify-between overflow-y-auto">
        
        {/* VIEW 1: LIVE VITAL MONITOR */}
        {activeTab === 'monitor' && (
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch w-full flex-1">
            
            {/* Left Hand side: Camera Feed Controls (xl:col-span-7) */}
            <div className="xl:col-span-7 flex flex-col gap-6">
              <div className="bg-panel-card border border-panel-border rounded-3xl p-6 shadow-sm flex flex-col relative overflow-hidden flex-1 justify-between">
                <h2 className="text-[10px] font-black text-text-secondary uppercase tracking-widest mb-4 flex items-center gap-2.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-accent-cyan animate-ping"></span>
                  Intake Acquisition Viewport
                </h2>

                {/* Viewport Frame with HUD overlay (larger size utilization) */}
                <div className="relative min-h-[480px] bg-slate-950/20 border border-panel-border rounded-2xl overflow-hidden mb-5 group flex items-center justify-center shadow-inner flex-1">
                  {backendOnline ? (
                    selectedCamera === -99 ? (
                      browserAnnotatedFrame ? (
                        <img 
                          src={browserAnnotatedFrame} 
                          alt="Local Browser Stream" 
                          className="w-full h-full object-contain"
                        />
                      ) : (
                        <div className="text-center p-6 text-text-secondary max-w-[340px]">
                          <div className="text-4xl mb-4 opacity-75">📹</div>
                          <p className="text-sm font-black text-text-primary uppercase tracking-wide">Browser Camera Ready</p>
                          <p className="text-xs text-text-secondary mt-2 leading-relaxed font-semibold">Click "Init Sensors" to launch your client-side webcam feed.</p>
                        </div>
                      )
                    ) : metrics.status === 'IMAGE_READY' || metrics.remark === 'IMAGE_DEMO' ? (
                      <img 
                        src={`${BACKEND_URL}/image_feed`} 
                        alt="Intake snap" 
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <img 
                        key={videoFeedKey}
                        src={`${BACKEND_URL}/video_feed?t=${videoFeedKey}`} 
                        alt="Medical Stream" 
                        className="w-full h-full object-contain"
                        onError={() => {
                          setTimeout(() => setVideoFeedKey(k => k + 1), 1000);
                        }}
                      />
                    )
                  ) : (
                    <div className="text-center p-6 text-text-secondary max-w-[340px]">
                      <div className="text-4xl mb-4 opacity-75">📡</div>
                      <p className="text-sm font-black text-text-primary uppercase tracking-wide">Intake Hardware Offline</p>
                      <p className="text-xs text-text-secondary mt-2 leading-relaxed font-semibold">Ensure Python backend API server is running on port 5002 with required dependencies.</p>
                    </div>
                  )}

                  {/* High-tech target corner brackets & sweeping line */}
                  {(metrics.status === 'CALIBRATING' || metrics.status === 'OK') && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden">
                      {/* Bounding bracket overlays */}
                      <div className="absolute top-8 left-8 w-6 h-6 border-t-2 border-l-2 border-accent-cyan/60 rounded-tl-md"></div>
                      <div className="absolute top-8 right-8 w-6 h-6 border-t-2 border-r-2 border-accent-cyan/60 rounded-tr-md"></div>
                      <div className="absolute bottom-8 left-8 w-6 h-6 border-b-2 border-l-2 border-accent-cyan/60 rounded-bl-md"></div>
                      <div className="absolute bottom-8 right-8 w-6 h-6 border-b-2 border-r-2 border-accent-cyan/60 rounded-br-md"></div>
                      
                      {/* Sweeping laser line */}
                      <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-accent-cyan to-transparent shadow-[0_0_10px_#06b6d4] opacity-50 absolute top-0 animate-[scan_6s_linear_infinite]"></div>
                    </div>
                  )}

                  {/* Floating acquisition state tags */}
                  <div className="absolute top-4 left-4 flex flex-wrap gap-2 pointer-events-none">
                    <span className={`text-[9px] font-extrabold uppercase px-2.5 py-1 rounded-md border ${
                      metrics.status === 'OK' ? 'bg-emerald-950/80 text-emerald-450 border-emerald-800/80 shadow-[0_0_10px_rgba(16,185,129,0.15)]' :
                      metrics.status === 'CALIBRATING' ? 'bg-cyan-950/80 text-accent-cyan border-cyan-800/80 animate-pulse' :
                      metrics.status === 'VIDEO_ENDED' ? 'bg-slate-900/80 text-text-secondary border-slate-700/80' :
                      metrics.status === 'IMAGE_READY' ? 'bg-purple-950/80 text-purple-400 border-purple-800/80' :
                      'bg-slate-950/80 text-text-secondary border-panel-border'
                    }`}>
                      {metrics.status}
                    </span>
                    
                    {metrics.face_detected && (
                      <span className="text-[9px] bg-cyan-950/80 text-accent-cyan border border-cyan-800/80 px-2.5 py-1 rounded-md font-extrabold tracking-wider">
                        TARGET LOCKED
                      </span>
                    )}
                  </div>
                </div>

                {/* Controller section */}
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-[9px] text-text-secondary font-black uppercase tracking-wider">Patient Identification (Full Name)</label>
                    <input 
                      type="text" 
                      placeholder="Enter patient full name (e.g. John Doe)..." 
                      value={patientName}
                      onChange={(e) => setPatientName(e.target.value)}
                      className="bg-panel-bg border border-panel-border rounded-xl text-sm p-3.5 text-text-primary outline-none focus:border-accent-cyan focus:ring-1 focus:ring-accent-cyan/25 transition-all font-semibold shadow-sm"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-[9px] text-text-secondary font-black uppercase tracking-wider">Optical Device</label>
                      <div className="relative">
                        <select 
                          value={selectedCamera !== null ? selectedCamera : ''}
                          onChange={(e) => setSelectedCamera(Number(e.target.value))}
                          className="w-full bg-panel-bg border border-panel-border rounded-xl text-sm p-3.5 text-text-primary outline-none focus:border-accent-cyan cursor-pointer appearance-none font-semibold shadow-sm"
                        >
                          {cameras.map((cam) => (
                            <option key={cam.index} value={cam.index}>{cam.label}</option>
                          ))}
                          {cameras.length === 0 && <option value="">No hardware found</option>}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-text-secondary">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-[9px] text-text-secondary font-black uppercase tracking-wider">Interface controls</label>
                      <div className="flex gap-2">
                        <button 
                          onClick={handleStartWebcam}
                          className="flex-1 bg-accent-cyan/10 hover:bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:border-accent-cyan/50 font-bold text-xs py-3 px-3 rounded-xl transition-all shadow-sm"
                        >
                          Init Sensors
                        </button>
                        <button 
                          onClick={metrics.is_live ? handleReleaseCamera : handleStartWebcam}
                          title={metrics.is_live ? "Release Hardware (Stop)" : "Initialize Hardware (Play)"}
                          className={`px-4 py-3 border rounded-xl transition-all flex items-center justify-center font-bold text-xs shadow-sm ${
                            metrics.is_live 
                              ? 'bg-rose-950/20 hover:bg-rose-900/20 border-rose-800/40 text-rose-450' 
                              : 'bg-emerald-950/20 hover:bg-emerald-900/20 border-emerald-800/40 text-emerald-450'
                          }`}
                        >
                          {metrics.is_live ? '⏹' : '▶'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-[9px] text-text-secondary font-black uppercase tracking-wider">Upload Record (Video / Image)</label>
                    <div className="relative border border-dashed border-panel-border hover:border-accent-cyan/50 bg-panel-bg/20 hover:bg-panel-bg/40 rounded-xl p-5 text-center cursor-pointer transition-all group">
                      <input 
                        type="file" 
                        accept="video/*,image/*" 
                        onChange={handleFileUpload}
                        className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                      />
                      <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto mb-2 text-text-secondary group-hover:text-accent-cyan transition-colors" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                      <div className="text-text-primary text-xs font-bold uppercase tracking-wide">
                        📂 Drop patient media file...
                      </div>
                      <p className="text-[9px] text-text-secondary mt-1 uppercase tracking-widest font-mono">Supports MP4, WebM, JPG, PNG</p>
                    </div>
                  </div>

                  {uploadMessage.text && (
                    <div className={`text-xs p-3 rounded-xl font-bold border ${
                      uploadMessage.type === 'success' ? 'bg-emerald-950/30 text-emerald-400 border-emerald-900/40' : 'bg-rose-950/30 text-rose-450 border-rose-900/40'
                    }`}>
                      {uploadMessage.text}
                    </div>
                  )}

                  {/* Signal Telemetry & Diagnostics */}
                  <div className="mt-2 bg-panel-bg/30 border border-panel-border rounded-2xl p-4 shadow-sm">
                    <div className="text-[9px] text-text-secondary font-black uppercase tracking-widest mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse"></span>
                        Signal Telemetry &amp; Diagnostics
                      </div>
                      <span className="font-mono text-[8px] text-text-muted bg-panel-bg px-2 py-0.5 rounded border border-panel-border font-bold">CHROM v2</span>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 font-mono text-[10px]">
                      <div className="flex justify-between items-center py-1 border-b border-panel-border/30">
                        <span className="text-text-secondary uppercase">Camera Status</span>
                        <span className={`font-black uppercase ${metrics.is_live ? 'text-emerald-500' : 'text-text-muted'}`}>
                          {metrics.is_live ? 'ACTIVE (30 FPS)' : 'OFFLINE'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center py-1 border-b border-panel-border/30">
                        <span className="text-text-secondary uppercase">Face ROI Lock</span>
                        <span className={`font-black uppercase ${metrics.face_detected ? 'text-accent-cyan' : 'text-text-muted'}`}>
                          {metrics.face_detected ? 'LOCKED' : 'NO LOCK'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center py-1 border-b border-panel-border/30">
                        <span className="text-text-secondary uppercase">Ambient Light</span>
                        <span className={`font-black uppercase ${metrics.estimated_lux > 100 ? 'text-emerald-500' : 'text-amber-500'}`}>
                          {metrics.estimated_lux} LUX
                        </span>
                      </div>
                      <div className="flex justify-between items-center py-1 border-b border-panel-border/30">
                        <span className="text-text-secondary uppercase">Stability</span>
                        <span className="text-text-primary font-black">{metrics.stability > 0 ? `${metrics.stability.toFixed(0)}%` : '--'}</span>
                      </div>
                      <div className="flex justify-between items-center py-1 border-b border-panel-border/30">
                        <span className="text-text-secondary uppercase">Noise (SNR)</span>
                        <span className="text-accent-cyan font-black">{metrics.snr_db > 0 ? `${Number(metrics.snr_db).toFixed(1)} dB` : '--'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Hand side: Vital Signs grid & PPG Plot (xl:col-span-5) */}
            <div className="xl:col-span-5 flex flex-col gap-6">
              
              {isTriageRunning && (
                <div className="bg-panel-card border border-panel-border rounded-2xl p-5 backdrop-blur-xl shadow-sm flex items-center gap-4 animate-pulse">
                  <div className="w-6 h-6 rounded-full border-2 border-accent-cyan border-t-transparent animate-spin shrink-0"></div>
                  <div>
                    <h3 className="text-[10px] font-black text-text-primary uppercase tracking-widest">Clinical Crew Swarm Running</h3>
                    <p className="text-[9px] text-text-secondary uppercase font-bold mt-1 leading-relaxed">
                      3-Agent pipeline is executing diagnostics, ESI acuity check, and saving record.
                    </p>
                  </div>
                </div>
              )}
              
              {/* VITALS GRID (Expanded to flex-1 to fill the vertical space) */}
              <div className="bg-panel-card border border-panel-border rounded-3xl p-6 shadow-sm flex flex-col justify-between flex-1 min-h-[380px]">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-[10px] font-black text-text-secondary uppercase tracking-widest flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]"></span>
                    Physiological Indicators
                  </h2>
                  
                  {/* Acquisition countdown timer */}
                  <div className="flex items-center gap-2 ml-auto">
                    {metrics.calibration_done && sessionTimer > 0 && (
                      <div className="flex items-center gap-2 bg-panel-bg border border-panel-border rounded-lg px-2.5 py-1 shadow-sm">
                        <svg width="24" height="24" viewBox="0 0 36 36" className="-rotate-90">
                          <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(56,189,248,0.1)" strokeWidth="3"/>
                          <circle cx="18" cy="18" r="14" fill="none" stroke="#38bdf8" strokeWidth="3"
                            strokeDasharray={`${2 * Math.PI * 14}`}
                            strokeDashoffset={`${2 * Math.PI * 14 * (1 - sessionTimer / 30)}`}
                            strokeLinecap="round" style={{transition: 'stroke-dashoffset 1s linear'}}/>
                          <text x="18" y="23" textAnchor="middle" fill="var(--text-primary)" fontSize="10" fontWeight="900"
                            style={{transform: 'rotate(90deg)', transformOrigin: '18px 18px'}}>{sessionTimer}</text>
                        </svg>
                        <div className="text-right">
                          <div className="text-[8px] text-text-secondary font-black uppercase tracking-widest leading-none">Acquisition</div>
                          <div className="text-[10px] text-accent-cyan font-black mt-0.5 leading-none">{sessionTimer}s left</div>
                        </div>
                      </div>
                    )}
                    {sessionTimer === 0 && !reportLoading && sessionReport && (
                      <div className="text-[9px] bg-emerald-950/60 border border-emerald-800/50 text-emerald-400 px-3 py-1 rounded-lg font-black uppercase tracking-widest flex items-center gap-1.5 shadow-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        Report Ready
                      </div>
                    )}
                    {reportLoading && (
                      <div className="text-[9px] text-accent-cyan font-black uppercase tracking-widest flex items-center gap-1.5 animate-pulse">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-ping"></span>
                        Analyzing Buffer...
                      </div>
                    )}
                  </div>
                </div>

                {/* Vertical-flexing cards for Physiological readings: Made taller & lengthier */}
                <div className="flex flex-col gap-4 flex-1">
                  
                  {/* HEART RATE */}
                  <div className={`bg-panel-bg/30 border rounded-2xl p-6 flex flex-col justify-between hover:border-text-secondary/20 transition-all duration-300 flex-1 min-h-[120px] ${
                    metrics.classification === 'TACHYCARDIA' ? 'border-rose-500/40 bg-rose-500/5 shadow-[0_0_15px_rgba(239,68,68,0.05)]' :
                    metrics.classification === 'NORMAL' ? 'border-emerald-500/20' :
                    'border-panel-border'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-text-secondary font-extrabold uppercase tracking-wider">Heart Rate</span>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4 text-rose-500 animate-heart-pulse">
                        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                      </svg>
                    </div>
                    <div className="my-2 flex items-baseline gap-2">
                      <span className="text-5xl font-black text-text-primary tracking-tight leading-none font-mono">
                        {metrics.bpm > 0 ? metrics.bpm : '--'}
                      </span>
                      <span className="text-[10px] text-text-secondary font-bold uppercase tracking-wider">BPM</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-panel-border/30 pt-2">
                      <span className={`text-[9px] px-2 py-0.5 rounded font-extrabold uppercase tracking-widest ${
                        metrics.classification === 'NORMAL' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' :
                        metrics.classification === 'TACHYCARDIA' ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' :
                        metrics.classification === 'BRADYCARDIA' ? 'bg-cyan-500/10 text-cyan-500 border border-cyan-500/20' :
                        'bg-panel-bg text-text-secondary'
                      }`}>
                        {metrics.classification}
                      </span>
                      <span className="text-[9px] text-text-secondary font-mono">Conf: {typeof metrics.confidence === 'number' ? metrics.confidence.toFixed(0) : metrics.confidence}%</span>
                    </div>
                  </div>

                  {/* RESPIRATORY RATE */}
                  <div className={`bg-panel-bg/30 border rounded-2xl p-6 flex flex-col justify-between hover:border-text-secondary/20 transition-all duration-300 flex-1 min-h-[120px] ${
                    metrics.rr_classification === 'TACHYPNEA' ? 'border-rose-500/40 bg-rose-500/5' :
                    metrics.rr_classification === 'NORMAL' ? 'border-emerald-500/20' :
                    'border-panel-border'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-text-secondary font-extrabold uppercase tracking-wider">Respiration</span>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4 text-cyan-500">
                        <path d="M2 12h3c.7 0 1.2-.6 1.4-1.2l1.2-3.6c.3-.9 1.6-.9 1.9 0l2 6c.3.9 1.6.9 1.9 0l1.2-3.6c.2-.6.7-1.2 1.4-1.2h6" />
                      </svg>
                    </div>
                    <div className="my-2 flex items-baseline gap-1.5 overflow-hidden">
                      <span className="text-5xl font-black text-text-primary tracking-tight leading-none font-mono truncate">
                        {metrics.rr > 0 ? Number(metrics.rr).toFixed(1) : '--'}
                      </span>
                      <span className="text-[10px] text-text-secondary font-bold uppercase tracking-wider shrink-0">B/min</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-panel-border/30 pt-2">
                      <span className={`text-[9px] px-2 py-0.5 rounded font-extrabold uppercase tracking-widest ${
                        metrics.rr_classification === 'NORMAL' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' :
                        metrics.rr_classification === 'TACHYPNEA' ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' :
                        metrics.rr_classification === 'BRADYPNEA' ? 'bg-cyan-500/10 text-cyan-500 border border-cyan-500/20' :
                        'bg-panel-bg text-text-secondary'
                      }`}>
                        {metrics.rr_classification}
                      </span>
                      <span className="text-[9px] text-text-secondary font-mono">Conf: {typeof metrics.rr_confidence === 'number' ? Number(metrics.rr_confidence).toFixed(0) : metrics.rr_confidence}%</span>
                    </div>
                  </div>

                  {/* STRESS INDEX */}
                  <div className={`bg-panel-bg/30 border rounded-2xl p-6 flex flex-col justify-between hover:border-text-secondary/20 transition-all duration-300 flex-1 min-h-[120px] ${
                    metrics.stress_index > 150 ? 'border-rose-500/40 bg-rose-500/5' :
                    metrics.stress_index > 80 ? 'border-amber-500/30 bg-amber-500/5' :
                    'border-panel-border'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-text-secondary font-extrabold uppercase tracking-wider">Stress Index</span>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4 text-amber-500">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                      </svg>
                    </div>
                    <div className="my-2 flex items-baseline gap-1.5 overflow-hidden">
                      <span className={`font-black text-text-primary tracking-tight leading-none font-mono ${
                        metrics.stress_index > 999 ? 'text-3xl' : 'text-5xl'
                      }`}>
                        {metrics.stress_index > 0 ? Number(metrics.stress_index).toFixed(0) : '--'}
                      </span>
                      <span className="text-[10px] text-text-secondary font-bold uppercase tracking-wider shrink-0">IDX</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-panel-border/30 pt-2">
                      <span className={`text-[9px] px-2 py-0.5 rounded font-extrabold uppercase tracking-widest ${
                        metrics.stress_index > 150 ? 'bg-rose-500/10 text-rose-500' :
                        metrics.stress_index > 80 ? 'bg-amber-500/10 text-amber-450' :
                        metrics.stress_index > 0 ? 'bg-emerald-500/10 text-emerald-500' :
                        'bg-panel-bg text-text-secondary'
                      }`}>
                        {metrics.stress_index > 150 ? 'CRITICAL' : metrics.stress_index > 80 ? 'ELEVATED' : metrics.stress_index > 0 ? 'OPTIMAL' : '--'}
                      </span>
                      <span className="text-[9px] text-text-secondary font-mono">HRV: {typeof metrics.hrv === 'number' ? Number(metrics.hrv).toFixed(0) : '--'}ms</span>
                    </div>
                  </div>

                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                  {/* SIGNAL QUALITY & SNR */}
                  <div className="bg-panel-bg/20 border border-panel-border rounded-xl p-4 flex items-center justify-between hover:border-text-secondary/20 transition-all">
                    <div>
                      <span className="text-[9px] text-text-secondary font-extrabold uppercase tracking-wider">Signal SNR</span>
                      <div className="text-xl font-black text-text-primary font-mono mt-1">{metrics.snr_db ? `${metrics.snr_db.toFixed(1)} dB` : '--'}</div>
                    </div>
                    <div className="text-right">
                      <span className="text-[9px] text-text-secondary font-extrabold uppercase tracking-wider">Stability</span>
                      <div className="text-xs font-bold text-accent-cyan font-mono mt-1">{metrics.stability_indicator} ({metrics.stability.toFixed(1)} bpm)</div>
                    </div>
                  </div>

                  {/* LIGHT & MOTION */}
                  <div className="bg-panel-bg/20 border border-panel-border rounded-xl p-4 flex items-center justify-between hover:border-text-secondary/20 transition-all">
                    <div>
                      <span className="text-[9px] text-text-secondary font-extrabold uppercase tracking-wider">Environment</span>
                      <div className="text-xs font-extrabold text-text-secondary mt-1 flex flex-col gap-0.5">
                        <span>Luminance: <strong className="text-text-primary font-mono">{metrics.estimated_lux} LUX</strong></span>
                        <span>Motion: <strong className="text-text-primary font-mono">{metrics.motion_delta.toFixed(1)}</strong></span>
                      </div>
                    </div>
                    <div className="text-[9px] text-text-secondary text-right leading-relaxed font-semibold">
                      <div>LIMIT: &gt;100 LUX</div>
                      <div>MOTION: &lt;15.0</div>
                    </div>
                  </div>
                </div>

                {metrics.warnings && metrics.warnings.length > 0 && (
                  <div className="mt-4 p-4 bg-rose-500/5 border border-rose-500/20 rounded-xl flex flex-col gap-1.5 shadow-[0_0_15px_rgba(239,68,68,0.03)] animate-pulse">
                    <div className="text-xs font-black text-rose-500 uppercase tracking-wider flex items-center gap-1.5">
                      ⚠️ Sensor telemetry alerts:
                    </div>
                    <ul className="list-disc list-inside text-xs text-rose-400 font-semibold leading-relaxed">
                      {metrics.warnings.map((w, idx) => <li key={idx}>{w}</li>)}
                    </ul>
                  </div>
                )}
              </div>

              {/* 30-SECOND SESSION REPORT */}
              {sessionReport && (
                <div className="bg-panel-card border border-emerald-500/20 rounded-3xl p-5 backdrop-blur-xl shadow-sm animate-in fade-in duration-500">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]"></span>
                      <h3 className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">30s Intake Session Telemetry</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] text-text-secondary font-mono font-bold uppercase">{sessionReport.generated_at}</span>
                      <button onClick={() => { setSessionReport(null); setSessionTimer(30); reportFetchedRef.current = false; }}
                        className="text-text-secondary hover:text-text-primary text-xs px-2 py-0.5 rounded border border-panel-border transition-colors font-mono">
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    <div className="bg-panel-bg border border-panel-border rounded-xl p-3 text-center">
                      <div className="text-[8px] text-text-secondary uppercase tracking-widest font-black mb-1">Avg BPM</div>
                      <div className="text-xl font-black font-mono text-text-primary">{sessionReport.vitals.heart_rate_avg ?? '--'}</div>
                      <div className={`text-[8px] mt-1 font-black uppercase tracking-widest ${
                        sessionReport.vitals.classification === 'NORMAL' ? 'text-emerald-500' :
                        sessionReport.vitals.classification === 'TACHYCARDIA' ? 'text-rose-500' : 'text-accent-cyan'
                      }`}>{sessionReport.vitals.classification}</div>
                    </div>
                    <div className="bg-panel-bg border border-panel-border rounded-xl p-3 text-center">
                      <div className="text-[8px] text-text-secondary uppercase tracking-widest font-black mb-1">Respiration</div>
                      <div className="text-xl font-black font-mono text-text-primary">{sessionReport.vitals.respiratory_rate ?? '--'}</div>
                      <div className="text-[8px] mt-1 font-black uppercase tracking-widest text-accent-cyan">{sessionReport.vitals.rr_classification}</div>
                    </div>
                    <div className="bg-panel-bg border border-panel-border rounded-xl p-3 text-center">
                      <div className="text-[8px] text-text-secondary uppercase tracking-widest font-black mb-1">HRV (RMSSD)</div>
                      <div className="text-xl font-black font-mono text-accent-indigo">{sessionReport.vitals.hrv_rmssd_ms ?? '--'}</div>
                      <div className="text-[8px] mt-1 font-bold text-text-secondary uppercase">ms</div>
                    </div>
                    <div className="bg-panel-bg border border-panel-border rounded-xl p-3 text-center">
                      <div className="text-[8px] text-text-secondary uppercase tracking-widest font-black mb-1">Stress</div>
                      <div className={`text-xl font-black font-mono ${
                        sessionReport.vitals.stress_label === 'CRITICAL' ? 'text-rose-500' :
                        sessionReport.vitals.stress_label === 'ELEVATED' ? 'text-amber-500' : 'text-emerald-500'
                      }`}>{sessionReport.vitals.stress_index ?? '--'}</div>
                      <div className={`text-[8px] mt-1 font-black uppercase tracking-widest ${
                        sessionReport.vitals.stress_label === 'CRITICAL' ? 'text-rose-500' :
                        sessionReport.vitals.stress_label === 'ELEVATED' ? 'text-amber-500' : 'text-emerald-500'
                      }`}>{sessionReport.vitals.stress_label}</div>
                    </div>
                  </div>

                  <div className="bg-panel-bg/60 border border-panel-border/70 rounded-xl p-4 mb-3">
                    <div className="text-[8px] text-text-secondary font-black uppercase tracking-widest mb-1.5">Interpretation Analysis</div>
                    <p className="text-xs text-text-primary leading-relaxed font-semibold">{sessionReport.clinical_summary}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-[8px] text-text-secondary font-bold uppercase tracking-wider">
                    <span>Conf: <strong className="text-text-primary">{sessionReport.signal_quality.confidence_pct}%</strong></span>
                    <span>SNR: <strong className="text-text-primary">{sessionReport.signal_quality.snr_db ?? '--'} dB</strong></span>
                    <span>Stability: <strong className="text-text-primary">{sessionReport.signal_quality.stability}</strong></span>
                    <span>Lux: <strong className="text-text-primary">{sessionReport.signal_quality.luminance_lux}</strong></span>
                    <span className="opacity-50">· {sessionReport.disclaimer}</span>
                  </div>
                </div>
              )}

              {/* RPPG CANVAS GRAPH */}
              <div className="bg-panel-card border border-panel-border rounded-3xl p-6 shadow-sm flex flex-col relative overflow-hidden justify-between h-[280px] shrink-0">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-[10px] font-black text-text-secondary uppercase tracking-widest flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-accent-cyan animate-pulse"></span>
                    rPPG Photonic Waveform Analysis
                  </h2>
                  <span className="text-[9px] text-text-secondary font-mono tracking-widest uppercase font-bold">
                    {metrics.sqi > 0 ? `SQI: ${metrics.sqi}%` : 'Calibrating signals...'}
                  </span>
                </div>
                
                <div className="relative bg-slate-950/20 border border-panel-border rounded-xl p-2 flex items-center justify-center overflow-hidden flex-1 min-h-[180px]">
                  <canvas 
                    ref={canvasRef} 
                    width={640} 
                    height={180} 
                    className="w-full h-full block"
                  />
                  
                  {metrics.status === 'CALIBRATING' && (
                    <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center p-3">
                      <div className="w-full max-w-xs bg-panel-bg rounded-full h-1.5 overflow-hidden border border-panel-border mb-2.5 relative">
                        <div 
                          className="bg-gradient-to-r from-accent-cyan to-accent-indigo h-full rounded-full transition-all duration-300 shadow-[0_0_10px_rgba(6,182,212,0.6)]"
                          style={{ width: `${metrics.calibration_progress}%` }}
                        ></div>
                      </div>
                      <span className="text-[9px] text-accent-cyan font-black tracking-widest animate-pulse uppercase">
                        Aligning Optical Sensors ({metrics.calibration_progress}%)
                      </span>
                    </div>
                  )}
                </div>
                
                <div className="flex items-center justify-between text-[8px] text-text-secondary mt-2 font-mono uppercase tracking-widest font-bold">
                  <span>0.00s</span>
                  <span>10s Rolling Sensor Buffer</span>
                  <span>10.00s</span>
                </div>
              </div>

            </div>

          </div>
        )}

        {/* VIEW 2: CENTRAL TRIAGE QUEUE */}
        {activeTab === 'queue' && (
          <div className="bg-panel-card border border-panel-border rounded-3xl p-6 shadow-sm flex flex-col min-h-[550px] relative overflow-hidden w-full flex-1">
            
            <div className="flex items-center justify-between border-b border-panel-border pb-4 mb-6">
              <div>
                <h2 className="text-base font-black text-text-primary uppercase tracking-wider flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-accent-cyan shadow-[0_0_8px_rgba(6,182,212,0.5)]"></span>
                  Central Triage Queue
                </h2>
                <p className="text-[10px] text-text-secondary uppercase tracking-widest font-black mt-1">Sorted dynamically by Acuity (ESI levels 1-2 prioritized to top)</p>
              </div>
              <button 
                onClick={handleClearQueue}
                className="text-rose-500 hover:text-rose-450 hover:bg-rose-500/5 border border-rose-500/25 text-xs font-black uppercase tracking-widest py-2 px-5 rounded-xl transition-colors shadow-sm animate-all"
              >
                Flush Queue
              </button>
            </div>

            <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1">
              {triageQueue.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-text-secondary py-24 text-center text-sm font-bold uppercase tracking-widest">
                  <div className="text-4xl mb-4 opacity-50">📋</div>
                  <p className="text-text-primary">Clinical Queue Empty</p>
                  <p className="text-[9px] text-text-secondary mt-1 uppercase font-mono">Processed ESI patient records will compile here.</p>
                </div>
              ) : (
                triageQueue.map((patient) => (
                  <div 
                    key={patient.id} 
                    className={`border border-panel-border rounded-2xl p-5 bg-panel-card/35 hover:bg-panel-card/75 transition-all duration-300 flex flex-col md:flex-row md:items-center justify-between gap-6 relative overflow-hidden group shadow-sm ${
                      patient.is_shock ? 'border-rose-500/30 shadow-[0_0_15px_rgba(239,68,68,0.03)] bg-rose-500/5' : ''
                    }`}
                  >
                    {/* Urgency Sidebar Indicator */}
                    <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${
                      patient.esi_level === 1 ? 'bg-red-500' :
                      patient.esi_level === 2 ? 'bg-orange-500' :
                      patient.esi_level === 3 ? 'bg-yellow-500' :
                      patient.esi_level === 4 ? 'bg-emerald-500' :
                      'bg-cyan-500'
                    }`}></div>

                    <div className="flex-1 pl-3.5">
                      <div className="flex flex-wrap items-center gap-4">
                        <span className="font-black text-text-primary text-base">{patient.name}</span>
                        <span className="text-[10px] font-mono text-text-secondary font-bold uppercase">{patient.timestamp}</span>
                        {patient.is_shock && (
                          <span className="text-[9px] bg-rose-500/10 text-rose-500 border border-rose-500/25 px-2.5 py-0.5 rounded font-black uppercase tracking-widest animate-pulse flex items-center gap-1.5 shadow-sm">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping"></span>
                            ⚠️ COMPENSATED SHOCK RISK
                          </span>
                        )}
                      </div>

                      <div className="mt-2 text-xs text-text-secondary leading-relaxed max-w-[1200px] font-medium">
                        {patient.triage_summary}
                      </div>

                      <div className="mt-4 flex flex-wrap items-center gap-5 text-[9px] text-text-secondary font-bold uppercase tracking-wider font-mono">
                        <span>Record ID: <strong className="text-text-primary">{patient.id}</strong></span>
                        <span>Source: <strong className="text-text-primary">{patient.video_path}</strong></span>
                        <span>Clinical Focus: <strong className="text-accent-cyan font-bold">{patient.primary_diagnosis}</strong></span>
                      </div>
                    </div>

                    <div className="flex flex-row md:flex-col items-center gap-3.5 self-start md:self-auto shrink-0">
                      <div className={`border rounded-xl py-2 px-4 text-center min-w-[95px] shadow-sm ${getEsiClass(patient.esi_level)}`}>
                        <div className="text-[8px] uppercase font-black tracking-widest opacity-85">ESI Acuity</div>
                        <div className="text-2xl font-black font-mono leading-none mt-1">{patient.esi_level}</div>
                      </div>
                      <div className="bg-panel-bg border border-panel-border text-text-secondary font-mono text-[9px] px-3.5 py-1.5 rounded-lg text-center min-w-[95px] font-bold uppercase tracking-wider shadow-sm font-semibold">
                        Score: <span className="text-text-primary font-black">{patient.priority_score}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

          </div>
        )}

        {/* VIEW 3: AGENT CREW PANEL */}
        {activeTab === 'crew' && (
          <div className="bg-panel-card border border-panel-border rounded-3xl p-6 shadow-sm flex flex-col min-h-[550px] relative overflow-hidden w-full flex-1">
            
            <div className="flex items-center justify-between border-b border-panel-border pb-4 mb-6">
              <div>
                <h2 className="text-base font-black text-text-primary uppercase tracking-wider flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-accent-cyan shadow-[0_0_8px_rgba(6,182,212,0.5)] animate-pulse"></span>
                  Clinical Swarm Orchestrator
                </h2>
                <p className="text-[10px] text-text-secondary uppercase tracking-widest font-black mt-1">Execution tracking logs of the 3-Agent Decoupled Triage pipeline</p>
              </div>

              <button 
                onClick={() => handleRunTriage()}
                disabled={isTriageRunning || metrics.status === 'DISCONNECTED'}
                className="bg-gradient-to-r from-accent-cyan to-accent-indigo disabled:from-slate-900 disabled:to-slate-900 disabled:text-text-secondary disabled:cursor-not-allowed text-white font-black text-xs py-3 px-6 rounded-xl transition-all shadow-sm flex items-center gap-2.5 uppercase tracking-wider"
              >
                {isTriageRunning ? (
                  <>
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin"></span>
                    Negotiating Swarm...
                  </>
                ) : (
                  <>
                    ⚡ Launch Triage Crew
                  </>
                )}
              </button>
            </div>

            {/* Agent selection tab layout */}
            <div className="flex gap-2 mb-5 bg-panel-bg/30 p-1.5 rounded-xl border border-panel-border overflow-hidden">
              <button 
                onClick={() => setActiveAgentTab('perception')}
                className={`flex-1 py-3 text-xs font-black uppercase tracking-widest rounded-lg transition-all ${
                  activeAgentTab === 'perception' 
                    ? 'text-accent-cyan bg-panel-card border border-panel-border shadow-sm' 
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                Perception Agent (Vitals Capture)
              </button>
              <button 
                onClick={() => setActiveAgentTab('diagnostic')}
                className={`flex-1 py-3 text-xs font-black uppercase tracking-widest rounded-lg transition-all ${
                  activeAgentTab === 'diagnostic' 
                    ? 'text-amber-500 bg-panel-card border border-panel-border shadow-sm' 
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                Diagnostic Agent (Acuity Assessment)
              </button>
              <button 
                onClick={() => setActiveAgentTab('coordinator')}
                className={`flex-1 py-3 text-xs font-black uppercase tracking-widest rounded-lg transition-all ${
                  activeAgentTab === 'coordinator' 
                    ? 'text-accent-cyan bg-panel-card border border-panel-border shadow-sm' 
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                Coordinator Agent (Queue Placement)
              </button>
            </div>

            {/* Main console screen */}
            <div className="bg-slate-950/95 border border-panel-border rounded-2xl p-5 flex-1 overflow-y-auto max-h-[420px] font-mono text-xs leading-relaxed text-emerald-400 min-h-[300px] shadow-inner">
              {isTriageRunning && (
                <div className="h-full flex flex-col items-center justify-center text-text-secondary py-16 gap-4">
                  <div className="w-8 h-8 rounded-full border-2 border-accent-cyan border-t-transparent animate-spin"></div>
                  <div className="text-center font-sans">
                    <p className="text-xs font-black text-text-primary uppercase tracking-widest">Multi-Agent Negotiation Active</p>
                    <p className="text-[10px] text-text-secondary mt-1 max-w-[400px] leading-relaxed uppercase tracking-widest font-black">Consolidating rPPG bio-telemetry, analyzing shock state indicators, and prioritizing patients...</p>
                  </div>
                </div>
              )}

              {!isTriageRunning && !lastTriageResult && (
                <div className="h-full flex items-center justify-center text-text-secondary text-center py-20 font-sans uppercase tracking-widest text-[10px] font-black">
                  <div>
                    <p className="opacity-75">Sensor pipeline idle.</p>
                    <p className="text-text-secondary/60 mt-1 uppercase font-mono">Upload a record or start live webcam and trigger Triage Crew.</p>
                  </div>
                </div>
              )}

              {!isTriageRunning && lastTriageResult && (
                <div>
                  {activeAgentTab === 'perception' && (
                    <div className="flex flex-col gap-3">
                      <div className="text-text-secondary border-b border-panel-border/30 pb-3 mb-2 font-sans font-black text-[10px] uppercase text-accent-cyan tracking-wider flex items-center justify-between">
                        <span>Perception Analysis Log</span>
                        <span>[COMPILED SUCCESS]</span>
                      </div>
                      <div className="whitespace-pre-wrap font-mono leading-relaxed font-semibold">
                        {`Patient Record: ${lastTriageResult.name}\nTimestamp: ${lastTriageResult.timestamp}\n\nACQUIRED PHYSIOLOGY:\n- Path: ${lastTriageResult.video_path}\n- Core Metrics Resolved:\n  • Heart Rate: ${metrics.bpm} BPM\n  • Respiration Rate: ${metrics.rr} breaths/min\n  • HRV: ${metrics.hrv.toFixed(1)} ms\n  • Stress Index: ${metrics.stress_index.toFixed(0)}\n  • Signal SNR: ${metrics.snr_db.toFixed(1)} dB\n\nDiagnostic buffer synchronized.`}
                      </div>
                    </div>
                  )}

                  {activeAgentTab === 'diagnostic' && (
                    <div className="flex flex-col gap-3">
                      <div className="text-text-secondary border-b border-panel-border/30 pb-3 mb-2 font-sans font-black text-[10px] uppercase text-amber-500 tracking-wider flex items-center justify-between">
                        <span>Clinical Diagnostic Assessment</span>
                        <span>[COMPILED SUCCESS]</span>
                      </div>
                      <div className="whitespace-pre-wrap font-mono leading-relaxed font-semibold">
                        {`DIAGNOSIS PATHOLOGY:\n- Recommended Index: ESI LEVEL ${lastTriageResult.esi_level}\n- Clinical Focus: ${lastTriageResult.primary_diagnosis}\n- Compensated Shock: ${lastTriageResult.is_shock ? "⚠️ SHOCK CRITERIA SATISFIED" : "STABLE / NO SHOCK"}\n\nESI CORRELATION LOGIC:\n- Cross-correlation analysis: HR (${metrics.bpm}) × RR (${metrics.rr})\n- Clinical documentation resolved.\n\nRaw decision trace:\n${lastTriageResult.agent_output.substring(0, 1500)}...`}
                      </div>
                    </div>
                  )}

                  {activeAgentTab === 'coordinator' && (
                    <div className="flex flex-col gap-4 font-sans p-2">
                      <div className="text-text-secondary border-b border-panel-border/30 pb-3 mb-2 font-sans font-black text-[10px] uppercase text-accent-cyan tracking-wider flex items-center justify-between">
                        <span>Dynamic Queue Allocation</span>
                        <span>[COMPILED SUCCESS]</span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-panel-bg border border-panel-border rounded-xl p-4 text-center">
                          <div className="text-[9px] text-text-secondary font-black uppercase tracking-wider">Acuity Level</div>
                          <div className="text-3xl font-black text-accent-cyan mt-1 font-mono">Level {lastTriageResult.esi_level}</div>
                        </div>
                        <div className="bg-panel-bg border border-panel-border rounded-xl p-4 text-center">
                          <div className="text-[9px] text-text-secondary font-black uppercase tracking-wider">Priority Rating</div>
                          <div className="text-3xl font-black text-accent-cyan mt-1 font-mono">{lastTriageResult.priority_score}/100</div>
                        </div>
                      </div>

                      <div className="bg-panel-bg border border-panel-border rounded-xl p-4">
                        <div className="text-[9px] text-text-secondary font-black uppercase tracking-wider mb-2">Primary Clinical Indicator</div>
                        <div className="flex items-center gap-3">
                          <span className={`w-3 h-3 rounded-full ${lastTriageResult.is_shock ? 'bg-red-500 animate-ping shadow-[0_0_8px_#ef4444]' : 'bg-emerald-500'}`}></span>
                          <span className={`text-sm font-bold ${lastTriageResult.is_shock ? 'text-rose-500' : 'text-text-primary'}`}>
                            {lastTriageResult.primary_diagnosis} {lastTriageResult.is_shock && "(Shock Indicator Active)"}
                          </span>
                        </div>
                      </div>

                      <div className="bg-panel-bg border border-panel-border rounded-xl p-4">
                        <div className="text-[9px] text-text-secondary font-black uppercase tracking-wider mb-2">Triage Summary & Rationale</div>
                        <p className="text-xs leading-relaxed text-text-primary font-semibold">{lastTriageResult.triage_summary}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        )}

        {/* VIEW 4: CLINICAL CONSULT (SPLIT-WORKSPACE) */}
        {activeTab === 'chat' && (
          <div className="bg-panel-card border border-panel-border rounded-3xl p-6 pb-4 shadow-sm flex flex-col flex-1 h-[calc(100vh-6rem)] max-h-[calc(100vh-6rem)] relative overflow-hidden w-full justify-between">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b border-panel-border pb-4 mb-4 w-full">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-panel-bg border border-panel-border flex items-center justify-center shadow-sm shrink-0">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2.5">
                    <h2 className="text-sm font-black text-text-primary uppercase tracking-wider">Clinical Consult</h2>
                    <span className="text-[8px] font-black uppercase tracking-widest bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/25 px-2 py-0.5 rounded">Active Assistant</span>
                  </div>
                  <p className="text-[9px] text-text-secondary font-black uppercase tracking-widest mt-0.5">Integrative Diagnostic Consult · OCR History Analysis · Guided Protocol Reference</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest bg-panel-bg border border-panel-border px-3 py-1.5 rounded-lg">
                <span className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse"></span>
                <span className="text-text-secondary">SYSTEM BIND ACTIVE</span>
              </div>
            </div>

            {/* Split Workspace Body */}
            <div className="flex flex-1 gap-6 overflow-hidden min-h-0">
              
              {/* Left Panel: Clinical Intake Summary Context */}
              <div className="hidden lg:flex flex-col gap-4 border-r border-panel-border/40 pr-6 w-72 shrink-0 justify-between">
                <div className="space-y-4">
                  <div className="text-[9px] text-text-secondary font-black uppercase tracking-widest">Active Patient Telemetry</div>
                  
                  {/* Select Dropdown to load database record */}
                  <div className="bg-panel-bg border border-panel-border rounded-xl p-3 shadow-sm flex flex-col gap-1.5">
                    <label className="text-[8px] text-text-secondary font-black uppercase tracking-wider">Select Patient Target</label>
                    <select
                      value={selectedConsultPatientId || ''}
                      onChange={(e) => setSelectedConsultPatientId(e.target.value || null)}
                      className="w-full bg-panel-card border border-panel-border rounded-lg text-xs p-2 text-text-primary outline-none focus:border-accent-cyan cursor-pointer appearance-none font-bold"
                    >
                      <option value="">-- Active Live Telemetry --</option>
                      {triageQueue.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (ESI {p.esi_level})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Vitals Summary Card Details */}
                  {(() => {
                    const consultPatient = selectedConsultPatientId 
                      ? triageQueue.find(p => p.id === selectedConsultPatientId) 
                      : null;
                    
                    return (
                      <div className="space-y-2.5">
                        <div className="bg-panel-bg border border-panel-border rounded-xl p-3.5 shadow-sm">
                          <div className="text-[8px] text-text-secondary uppercase tracking-wider font-bold">Identified Subject</div>
                          <div className="text-xs font-black text-text-primary truncate mt-1">
                            {consultPatient ? consultPatient.name : (patientName || 'Anonymous / Intake Subject')}
                          </div>
                        </div>

                        <div className="bg-panel-bg border border-panel-border rounded-xl p-3.5 shadow-sm">
                          <div className="text-[8px] text-text-secondary uppercase tracking-wider font-bold">Intake Vital Readings</div>
                          <div className="mt-2 space-y-2 font-mono text-[10px]">
                            <div className="flex justify-between items-center py-0.5">
                              <span className="text-text-secondary">Heart Rate</span>
                              <span className="text-text-primary font-black">
                                {consultPatient 
                                  ? (consultPatient.heart_rate && consultPatient.heart_rate > 0 ? `${consultPatient.heart_rate.toFixed(0)} BPM` : '--') 
                                  : (metrics.bpm > 0 ? `${metrics.bpm} BPM` : '--')}
                              </span>
                            </div>
                            <div className="flex justify-between items-center py-0.5">
                              <span className="text-text-secondary">Respiration</span>
                              <span className="text-text-primary font-black">
                                {consultPatient 
                                  ? (consultPatient.respiration && consultPatient.respiration > 0 ? `${consultPatient.respiration.toFixed(1)} B/min` : '--') 
                                  : (metrics.rr > 0 ? `${metrics.rr.toFixed(1)} B/min` : '--')}
                              </span>
                            </div>
                            <div className="flex justify-between items-center py-0.5">
                              <span className="text-text-secondary">Stress Index</span>
                              <span className="text-text-primary font-black">
                                {consultPatient 
                                  ? (consultPatient.stress_index && consultPatient.stress_index > 0 ? consultPatient.stress_index.toFixed(0) : '--') 
                                  : (metrics.stress_index > 0 ? metrics.stress_index.toFixed(0) : '--')}
                              </span>
                            </div>
                            <div className="flex justify-between items-center py-0.5">
                              <span className="text-text-secondary">HRV (RMSSD)</span>
                              <span className="text-text-primary font-black">
                                {consultPatient 
                                  ? (consultPatient.hrv && consultPatient.hrv > 0 ? `${consultPatient.hrv.toFixed(0)} ms` : '--') 
                                  : (metrics.hrv > 0 ? `${metrics.hrv.toFixed(0)} ms` : '--')}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="bg-panel-bg border border-panel-border rounded-xl p-3.5 shadow-sm">
                          <div className="text-[8px] text-text-secondary uppercase tracking-wider font-bold">Assigned Acuity Profile</div>
                          {consultPatient ? (
                            <div className="mt-2 space-y-2 text-[10px] font-semibold">
                              <div className="flex justify-between items-center">
                                <span className="text-text-secondary">ESI Rating</span>
                                <span className="text-accent-cyan font-black">Level {consultPatient.esi_level}</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-text-secondary">Priority Score</span>
                                <span className="text-text-primary font-mono">{consultPatient.priority_score}/100</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-text-secondary">Shock State</span>
                                <span className={consultPatient.is_shock ? 'text-rose-500 font-black' : 'text-emerald-500'}>
                                  {consultPatient.is_shock ? 'SHOCK CRITERIA' : 'STABLE'}
                                </span>
                              </div>
                            </div>
                          ) : lastTriageResult ? (
                            <div className="mt-2 space-y-2 text-[10px] font-semibold">
                              <div className="flex justify-between items-center">
                                <span className="text-text-secondary">ESI Rating</span>
                                <span className="text-accent-cyan font-black">Level {lastTriageResult.esi_level}</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-text-secondary">Priority Score</span>
                                <span className="text-text-primary font-mono">{lastTriageResult.priority_score}/100</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-text-secondary">Shock State</span>
                                <span className={lastTriageResult.is_shock ? 'text-rose-500 font-black' : 'text-emerald-500'}>
                                  {lastTriageResult.is_shock ? 'SHOCK CRITERIA' : 'STABLE'}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="text-[10px] text-text-secondary mt-1.5 italic font-bold">No ESI Acuity resolved. Run triage swarm.</div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="text-[8px] text-text-secondary/70 leading-relaxed font-bold uppercase tracking-wider">
                  💡 consult assistant inherits read-only context of current postgres telemetry buffers.
                </div>
              </div>

              {/* Right Panel: Chat Consult Feed */}
              <div className="flex-1 flex flex-col justify-between overflow-hidden min-h-0">
                <div className="flex-grow bg-panel-bg/30 border border-panel-border rounded-2xl p-5 overflow-y-auto flex flex-col gap-4 shadow-inner min-h-0">
                  {chatHistory.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-text-secondary text-center py-16">
                      <div className="w-11 h-11 rounded-2xl bg-panel-bg border border-panel-border flex items-center justify-center mb-3 shadow-sm">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                      </div>
                      <p className="text-text-primary font-black text-sm uppercase tracking-wider">Clinical Consult Session Ready</p>
                      <p className="text-xs text-text-secondary mt-1 max-w-[400px] leading-relaxed font-semibold">
                        Submit questions regarding the subject's vital metrics, request differential diagnostics, or attach intake charts/lab records for direct OCR analysis.
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2 justify-center max-w-[480px]">
                        {['Explain ESI level guidelines', 'What does high stress indicate?', 'OCR parse blood report'].map(s => (
                          <button key={s} onClick={() => setChatInput(s)} className="text-xs bg-panel-bg border border-panel-border text-text-secondary hover:text-text-primary px-3 py-1.5 rounded-lg font-bold uppercase tracking-wider transition-colors shadow-sm">{s}</button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    chatHistory.map((msg, idx) => (
                      <div key={idx} className={`flex flex-col max-w-[85%] ${msg.role === 'user' ? 'self-end items-end' : 'self-start items-start'}`}>
                        <span className="text-[8px] text-text-secondary font-black uppercase tracking-widest mb-1">
                          {msg.role === 'user' ? 'Clinician' : 'ARIA'}
                        </span>
                        
                        <div className={`p-3.5 rounded-2xl text-sm leading-relaxed font-semibold whitespace-pre-wrap relative ${
                          msg.role === 'user' 
                            ? 'bg-sky-950/20 text-text-primary border border-sky-850/30 rounded-tr-none shadow-sm' 
                            : 'bg-panel-card text-text-primary border border-panel-border rounded-tl-none shadow-sm pb-8'
                        }`}>
                          {msg.image && (
                            <div className="mb-2 max-w-[180px] rounded-lg overflow-hidden border border-panel-border shadow-sm">
                              <img src={msg.image} alt="Clinical record attachment" className="w-full h-auto object-cover" />
                            </div>
                          )}
                          <div>
                            {msg.content.replace(/^\[[a-z]{2}-[A-Z]{2}\]\s*/i, '').replace(/\*\*/g, '').replace(/\* /g, '• ')}
                          </div>

                          {/* Manual Speaker Icon Toggle for ARIA's messages */}
                          {msg.role === 'model' && (
                            <button
                              type="button"
                              onClick={() => speakText(msg.content, idx)}
                              className={`absolute bottom-2 right-3 text-text-secondary transition-colors text-xs p-1 bg-panel-bg/60 rounded-md border flex items-center justify-center w-6 h-6 shadow-sm ${
                                speakingMessageIdx === idx 
                                  ? 'border-accent-cyan text-accent-cyan shadow-[0_0_10px_rgba(56,189,248,0.3)] animate-pulse' 
                                  : 'border-panel-border/30 hover:border-accent-cyan/30 hover:text-accent-cyan'
                              }`}
                              title={speakingMessageIdx === idx ? "Mute/Stop Voice Output" : "Listen to this response"}
                            >
                              {speakingMessageIdx === idx ? '🔇' : '🔊'}
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  {isChatLoading && (
                    <div className="self-start flex items-center gap-2 text-[9px] text-accent-cyan uppercase tracking-widest font-black font-mono animate-pulse bg-panel-card px-3 py-1.5 rounded-lg border border-panel-border shadow-sm">
                      <span className="w-2 h-2 rounded-full bg-accent-cyan animate-ping"></span>
                      Consulting Engine...
                    </div>
                  )}
                  <div ref={chatEndRef}></div>
                </div>

                {/* Input Form at bottom */}
                <form onSubmit={handleSendChatMessage} className="flex flex-col gap-2 mt-2 w-full">
                  {selectedImage && (
                    <div className="flex items-center gap-3 p-3 bg-panel-bg/40 border border-panel-border rounded-xl animate-pulse shadow-sm">
                      <div className="w-9 h-9 rounded-lg overflow-hidden border border-panel-border relative">
                        <img src={selectedImage} alt="Preview" className="w-full h-full object-cover" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-bold text-text-primary truncate">Intake Document Attachment Loaded</p>
                        <p className="text-[8px] text-text-secondary uppercase font-mono tracking-wider font-bold">Ready for OCR parsing</p>
                      </div>
                      <button 
                        type="button" 
                        onClick={() => setSelectedImage(null)}
                        className="text-rose-500 hover:text-rose-450 font-black text-[9px] p-2 uppercase tracking-wider"
                      >
                        ✕ remove
                      </button>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <input 
                      type="file" 
                      accept="image/*" 
                      ref={imageInputRef}
                      onChange={handleImageAttachment}
                      className="hidden"
                    />
                    <button 
                      type="button"
                      onClick={() => imageInputRef.current?.click()}
                      className="p-3 rounded-xl border border-panel-border bg-panel-card text-text-secondary hover:text-text-primary hover:border-text-secondary/35 transition-all text-xs font-bold shadow-sm"
                      title="Attach Document Photo"
                    >
                      📎 Attach
                    </button>
                    <button 
                      type="button"
                      onClick={toggleRecording}
                      className={`p-3 rounded-xl border transition-all text-xs font-bold shadow-sm ${
                        isRecording 
                          ? 'bg-rose-500/10 text-rose-500 border-rose-500/35 animate-pulse' 
                          : 'bg-panel-card text-text-secondary border-panel-border hover:text-text-primary hover:border-text-secondary/35'
                      }`}
                      title="Voice Input (STT)"
                    >
                      🎙️ Speak
                    </button>
                    <input 
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="Ask ARIA about active patient biometrics, ESI metrics, or clinical protocols..."
                      className="flex-1 bg-panel-bg border border-panel-border rounded-xl text-sm px-3.5 text-text-primary outline-none focus:border-accent-cyan transition-all shadow-inner font-semibold"
                    />
                    <button 
                      type="submit"
                      disabled={isChatLoading || (!chatInput.trim() && !selectedImage)}
                      className="bg-accent-cyan/15 hover:bg-accent-cyan/25 border border-accent-cyan/30 text-accent-cyan font-black text-xs py-3 px-5 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed uppercase tracking-wider shadow-sm"
                    >
                      Send
                    </button>
                  </div>
                </form>
              </div>
            </div>

          </div>
        )}

      </main>

    </div>
  );
}
