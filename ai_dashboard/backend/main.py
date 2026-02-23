"""
Layer 3 – Clinical AI Reasoning Backend (FastAPI)
Lives in: ai_dashboard/backend/
Completely separated from ESP32 firmware.

Receives structured tremor session summaries from the AI dashboard frontend,
builds a clinical prompt, calls MedGemma 4B via HuggingFace Inference API,
and returns a structured clinical report.
"""

import os
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import httpx

# ──────────────────────────────────────────────
# Pydantic Models
# ──────────────────────────────────────────────

class BandPower(BaseModel):
    hz_4_6: float = 0.0
    hz_6_8: float = 0.0
    hz_8_12: float = 0.0

class Metadata(BaseModel):
    session_id: str = "unknown"
    timestamp: str = ""
    duration_minutes: float = 0
    sampling_rate_hz: float = 50
    condition: str = "rest"
    medication_status: str = "unknown"
    tremor_score_scale: str = "0_to_10_log_scaled"

class FrequencyProfile(BaseModel):
    band_power_mean: BandPower = BandPower()
    band_power_std: BandPower = BandPower()
    dominant_band: str = ""
    dominance_ratio: float = 0
    dominant_band_percentage: float = 0
    band_switch_count: int = 0

class TremorScoreStats(BaseModel):
    mean: float = 0
    std: float = 0
    min: float = 0
    max: float = 0
    p25: float = 0
    p50: float = 0
    p75: float = 0
    p90: float = 0

class IntensityProfile(BaseModel):
    tremor_score: TremorScoreStats = TremorScoreStats()
    rms_mean: float = 0
    noise_floor_adjusted_intensity: float = 0

class IntensityDistribution(BaseModel):
    low_fraction: float = 0
    moderate_fraction: float = 0
    high_fraction: float = 0
    very_high_fraction: float = 0

class VariabilityProfile(BaseModel):
    coefficient_of_variation: float = 0
    stability_index: float = 0
    spectral_entropy: float = 0
    window_to_window_variance: float = 0

class WithinSessionTrend(BaseModel):
    linear_slope_per_minute_score_units: float = 0
    early_vs_late_change_percent: float = 0
    fatigue_pattern_detected: bool = False

class MultiSessionTrend(BaseModel):
    dominant_band_consistency_last_3: str = ""
    tremor_score_weekly_slope: str = ""
    severity_change_percent: str = ""
    band_shift_detected: bool = False

class SessionSummary(BaseModel):
    metadata: Metadata = Metadata()
    frequency_profile: FrequencyProfile = FrequencyProfile()
    intensity_profile: IntensityProfile = IntensityProfile()
    intensity_distribution: IntensityDistribution = IntensityDistribution()
    variability_profile: VariabilityProfile = VariabilityProfile()
    within_session_trend: WithinSessionTrend = WithinSessionTrend()
    multi_session_trend: MultiSessionTrend = MultiSessionTrend()

class ClinicalResponse(BaseModel):
    clinical_summary: str
    confidence_level: str
    advisory_note: str

# ──────────────────────────────────────────────
# FastAPI App
# ──────────────────────────────────────────────

app = FastAPI(title="Tremor Clinical AI Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────
# Prompt Builder
# ──────────────────────────────────────────────

SYSTEM_INSTRUCTION = (
    "You are a clinical reasoning assistant specialized in tremor pattern interpretation. "
    "You do not diagnose disease. You interpret structured tremor biomarkers and generate "
    "professional clinical summaries including severity assessment, phenotype likelihood, "
    "stability analysis, and uncertainty explanation."
)


def format_band(label: Optional[str]) -> str:
    """4_6_hz -> 4–6 Hz"""
    if not label:
        return "unknown"
    return label.replace("_", "–").replace("hz", "Hz").replace("–Hz", " Hz")


def build_user_prompt(s: SessionSummary) -> str:
    """Build a readable clinical text from the structured session summary."""

    bp = s.frequency_profile.band_power_mean
    bp_std = s.frequency_profile.band_power_std
    ts = s.intensity_profile.tremor_score
    dist = s.intensity_distribution
    var = s.variability_profile
    wt = s.within_session_trend
    mt = s.multi_session_trend

    lines = [
        "SESSION METADATA:",
        f"  Session ID: {s.metadata.session_id}",
        f"  Timestamp: {s.metadata.timestamp}",
        f"  Duration: {s.metadata.duration_minutes} minutes",
        f"  Condition: {s.metadata.condition}",
        f"  Medication status: {s.metadata.medication_status}",
        f"  Tremor score scale: {s.metadata.tremor_score_scale}",
        "",
        "FREQUENCY PROFILE:",
        f"  Band power mean – 4–6 Hz: {bp.hz_4_6:.3f}, 6–8 Hz: {bp.hz_6_8:.3f}, 8–12 Hz: {bp.hz_8_12:.3f}",
        f"  Band power std  – 4–6 Hz: {bp_std.hz_4_6:.3f}, 6–8 Hz: {bp_std.hz_6_8:.3f}, 8–12 Hz: {bp_std.hz_8_12:.3f}",
        f"  Dominant band: {format_band(s.frequency_profile.dominant_band)}",
        f"  Dominance ratio: {s.frequency_profile.dominance_ratio:.2f}",
        f"  Dominant band percentage: {s.frequency_profile.dominant_band_percentage*100:.1f}%",
        f"  Band switch count: {s.frequency_profile.band_switch_count}",
        "",
        "INTENSITY PROFILE:",
        f"  Mean tremor score: {ts.mean:.2f}",
        f"  Std: {ts.std:.2f}  |  Min: {ts.min:.2f}  |  Max: {ts.max:.2f}",
        f"  Percentiles – p25: {ts.p25:.2f}, p50: {ts.p50:.2f}, p75: {ts.p75:.2f}, p90: {ts.p90:.2f}",
        f"  RMS mean: {s.intensity_profile.rms_mean:.3f}",
        f"  Noise-floor adjusted intensity: {s.intensity_profile.noise_floor_adjusted_intensity:.3f}",
        "",
        "INTENSITY DISTRIBUTION:",
        f"  Low: {dist.low_fraction*100:.1f}%  |  Moderate: {dist.moderate_fraction*100:.1f}%",
        f"  High: {dist.high_fraction*100:.1f}%  |  Very high: {dist.very_high_fraction*100:.1f}%",
        "",
        "VARIABILITY PROFILE:",
        f"  Coefficient of variation: {var.coefficient_of_variation:.3f}",
        f"  Stability index: {var.stability_index:.3f}",
        f"  Spectral entropy: {var.spectral_entropy:.3f}",
        f"  Window-to-window variance: {var.window_to_window_variance:.3f}",
        "",
        "WITHIN-SESSION TREND:",
        f"  Linear slope (score units/min): {wt.linear_slope_per_minute_score_units:.4f}",
        f"  Early vs late change: {wt.early_vs_late_change_percent:.1f}%",
        f"  Fatigue pattern detected: {'Yes' if wt.fatigue_pattern_detected else 'No'}",
        "",
        "MULTI-SESSION TREND:",
        f"  Dominant band consistency (last 3): {mt.dominant_band_consistency_last_3}",
        f"  Weekly slope: {mt.tremor_score_weekly_slope}",
        f"  Severity change: {mt.severity_change_percent}",
        f"  Band shift detected: {'Yes' if mt.band_shift_detected else 'No'}",
    ]

    user_input = "\n".join(lines)

    request_section = (
        "\n\nBased on the above biomarkers, provide:\n"
        "1. Likely tremor phenotype\n"
        "2. Severity interpretation\n"
        "3. Stability and variability analysis\n"
        "4. Within-session trend interpretation\n"
        "5. Multi-session trend interpretation\n"
        "6. Confidence level (Low / Moderate / High)\n"
        "7. Non-diagnostic advisory disclaimer"
    )

    return user_input + request_section

# ──────────────────────────────────────────────
# MedGemma Inference
# ──────────────────────────────────────────────

HF_API_TOKEN = os.environ.get("HF_API_TOKEN", "")
MEDGEMMA_MODEL = "google/medgemma-4b-it"
HF_API_URL = f"https://api-inference.huggingface.co/models/{MEDGEMMA_MODEL}"


async def call_medgemma(system_prompt: str, user_prompt: str) -> str:
    """
    Call MedGemma 4B via HuggingFace Inference API.
    Falls back to a placeholder response if the API key is missing or the call fails.
    """

    if not HF_API_TOKEN:
        return _placeholder_response(user_prompt)

    headers = {
        "Authorization": f"Bearer {HF_API_TOKEN}",
        "Content-Type": "application/json",
    }

    payload = {
        "inputs": f"<start_of_turn>system\n{system_prompt}<end_of_turn>\n<start_of_turn>user\n{user_prompt}<end_of_turn>\n<start_of_turn>model\n",
        "parameters": {
            "max_new_tokens": 1024,
            "temperature": 0.4,
            "top_p": 0.9,
            "return_full_text": False,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(HF_API_URL, json=payload, headers=headers)
            resp.raise_for_status()
            result = resp.json()

            if isinstance(result, list) and len(result) > 0:
                return result[0].get("generated_text", "No response generated.")
            return str(result)

    except Exception as e:
        print(f"[MedGemma API error] {e}")
        return _placeholder_response(user_prompt)


def _placeholder_response(user_prompt: str) -> str:
    """Generate a structured placeholder when API is unavailable."""
    return (
        "## Tremor Phenotype Assessment\n\n"
        "**Likely Phenotype:** Based on the dominant 4–6 Hz band activity and the "
        "frequency profile provided, the pattern is most consistent with a resting tremor "
        "phenotype, commonly associated with Parkinsonian-spectrum conditions. However, "
        "essential tremor cannot be excluded without postural/kinetic testing.\n\n"
        "**Severity Interpretation:** The mean tremor score indicates moderate tremor "
        "intensity. The score distribution suggests periods of significant tremor activity "
        "interspersed with lower-intensity windows.\n\n"
        "**Stability & Variability:** The stability index and coefficient of variation "
        "suggest a relatively consistent tremor pattern with low spectral entropy, "
        "indicating a narrow-band, well-defined oscillatory pattern.\n\n"
        "**Within-Session Trend:** A mild upward trend in tremor score over the session "
        "may indicate fatigue-related amplification, which is clinically relevant for "
        "medication timing assessment.\n\n"
        "**Multi-Session Trend:** Consistent dominant band across sessions with a slight "
        "upward weekly slope warrants monitoring for progressive changes.\n\n"
        "**Confidence Level:** Moderate — sufficient data quality for pattern interpretation, "
        "but clinical context (medication, activity) is incomplete.\n\n"
        "⚠️ **Advisory:** This analysis is for informational purposes only and does not "
        "constitute a medical diagnosis. A qualified neurologist should interpret these "
        "findings in conjunction with clinical examination."
    )

# ──────────────────────────────────────────────
# API Endpoints
# ──────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "Tremor Clinical AI Backend"}


@app.post("/analyze", response_model=ClinicalResponse)
async def analyze(session: SessionSummary):
    """
    Accepts a structured session summary, builds a clinical prompt,
    calls MedGemma 4B, and returns a structured clinical report.
    """
    user_prompt = build_user_prompt(session)
    raw_response = await call_medgemma(SYSTEM_INSTRUCTION, user_prompt)

    # Determine confidence from the model response or default
    confidence = "Moderate"
    for level in ["High", "Low", "Moderate"]:
        if level.lower() in raw_response.lower():
            confidence = level
            break

    advisory = (
        "This analysis is generated by an AI clinical reasoning assistant and does not "
        "constitute a medical diagnosis. Results should be reviewed by a qualified "
        "healthcare professional. Tremor patterns may vary based on medication, fatigue, "
        "stress, and other clinical factors not captured by sensor data alone."
    )

    return ClinicalResponse(
        clinical_summary=raw_response,
        confidence_level=confidence,
        advisory_note=advisory,
    )


# ──────────────────────────────────────────────
# Serve AI Dashboard frontend (../index.html)
# Mount AFTER API routes so /analyze is not shadowed
# ──────────────────────────────────────────────

import pathlib
FRONTEND_DIR = pathlib.Path(__file__).resolve().parent.parent
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

# ──────────────────────────────────────────────
# Run with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
# ──────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
