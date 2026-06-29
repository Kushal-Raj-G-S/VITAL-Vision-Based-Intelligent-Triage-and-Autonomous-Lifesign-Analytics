# VITAL: Restructuring to a Next.js & Python SaaS Architecture

This updated plan details the integration of a **Next.js frontend** (in a `/frontend` subdirectory) with our **Flask Python backend** (running on the root) to create a premium SaaS application. 

To satisfy the academic requirement of **novelty**, our agents will directly address key limitations identified in the 30 IEEE research papers in your `research/` directory.

---

## 🏗️ Decoupled SaaS Architecture

To prevent clashing between Python environment files and Node.js files, we will run a decoupled setup:

```
VITAL-Vision-Based-Intelligent-Triage/
├── frontend/                     # Next.js Frontend App (React, TypeScript, CSS)
│   ├── src/
│   │   ├── app/                  # App Router pages (Dashboard, Chatbot, Queue)
│   │   └── components/           # Reusable UI cards, gauges, charts
│   ├── package.json
│   └── ...
│
├── core/                         # Core Biometric & Signal Processing Engine (Perception Layer)
│   ├── __init__.py
│   ├── camera.py                 # MediaPipe ROI tracking
│   └── rppg.py                   # CHROM & digital signal processing (Upsampling/HRV/Stress)
│
├── agents/                       # Multi-Agent Framework (CrewAI / LangChain)
│   ├── __init__.py
│   ├── config/                   # CrewAI YAML configurations
│   │   ├── agents.yaml           # Personas for Perception, Diagnostic, and Coordinator Agents
│   │   └── tasks.yaml            # Specifications for Vitals, Triage, and Prioritization Tasks
│   ├── tools.py                  # Agent-accessible tools
│   └── crew.py                   # CrewAI orchestration class (managing 3-Agent workflow)
│
├── scripts/                      # Offline Utilities & Benchmarks
│   ├── analyze_video.py          # Offline video analyzer
│   ├── validate_dataset.py       # MAE validation script
│   └── open.py                   # Standalone NLP text tool
│
├── uploads/                      # Uploaded Patient Media
├── requirements.txt              # Python Backend dependencies
├── .env                          # Configuration keys
└── app.py                        # Backend API Server (Flask on port 5002)
```

---

## 🛠️ The Novelty Strategy (Solving Paper Limitations)

Our product will target and resolve three specific limitations from the IEEE literature reviews:

1. **Tabular Note Sparsity / Incomplete Data** (*Arnaud et al. 2020; Fakhfakh-Maala et al. 2022*):
   * *Our Novel Solution*: The **Diagnostic Agent** evaluates vitals using polynomial cross-correlations (e.g. Heart Rate $\times$ Respiration Rate for Compensated Shock), and if narrative clinical details are missing, it uses RAG to infer symptoms or flags them to the clinician.
2. **Clinical Alert Fatigue & Lack of Explainability** (*Liu & Tsai 2024; Jonatha & Lubis 2025*):
   * *Our Novel Solution*: The **Diagnostic Agent** outputs its reasoning grounded in official ESI/WHO guidelines, rendering visible explainability highlights.
3. **Ineffective Static Queuing (FIFO)** (*Esan & Elegbeleye 2024; Sandal et al. 2025*):
   * *Our Novel Solution*: The **Coordinator Agent** runs a dynamic queuing priority model that ranks patients by ESI acuity level, automatically shuffling the most critical patients (like those in Compensated Shock) to the top of the centralized triage queue in real time.

---

## 🚀 Step-by-Step Implementation Roadmap

### Phase 1: Clean Up & Python Restructuring
1. Relocate `camera.py` and `rppg.py` under `core/`.
2. Create `agents/` directory containing `crew.py`, `tools.py`, and YAML configs.
3. Move utilities `analyze_video.py`, `validate_dataset.py`, and `open.py` to `scripts/`.
4. Update `app.py` to serve purely as an API server (disabling HTML templates).

### Phase 2: Complete the Multi-Agent Crew Configurations
1. **`agents/config/agents.yaml`** and **`agents/config/tasks.yaml`**: Define YAML attributes for Perception Agent, Diagnostic Agent, and Coordinator Agent.
2. **`agents/crew.py`**: Create the updated Crew class that dynamically loads agents/tasks from YAML config.

### Phase 3: Next.js Frontend Initialization
1. In accordance with guidelines, first query `npx create-next-app --help` to examine setup flags.
2. Create the frontend folder: `npx create-next-app@latest frontend --typescript --eslint --tailwind --src-dir --app --import-alias "@/*"` (using non-interactive flags).

### Phase 4: Build the Next.js SaaS Interface
1. **Biometric Dashboard**: Build a gorgeous interface with CSS transitions, real-time vital gauges, and an interactive canvas for the rPPG signal plot.
2. **Dynamic Triage Queue**: Create a live queue component that polls `/status` and `/session_summary` from the Flask API, sorting patients by ESI acuity.
3. **OptiBot AI Assistant**: Integrate voice recording (Web Audio API) and text chat connected to `/api/chat` with Gemini.
4. **Multimodal OCR & Document Analysis**: Add a file attachment UI in Next.js `page.tsx` and image parsing logic in Flask `routes.py`. The backend will parse the image and perform native OCR/reasoning through Gemini's vision capability.

---

## 📈 Verification Plan

### Automated Verification
* Verify imports of all Python packages:
  ```powershell
  python -c "import core.camera; import core.rppg; import agents.crew; print('Python Backend OK')"
  ```
* Verify Next.js builds:
  ```powershell
  cd frontend; npm run build
  ```

### Manual Verification
* Start the Flask API on `http://127.0.0.1:5002`.
* Start the Next.js dev server on `http://localhost:3000`.
* Upload videos and verify the 3-agent Crew execution, ESI classification, and live sorting of patients on the Next.js dashboard.
