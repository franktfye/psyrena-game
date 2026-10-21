"""
Rank voice-design rolls for a new hero voice (used for Erikson, 2026-10-18).

    python tools/voice-rank.py "<reference text>" roll1.wav roll2.wav ... --vs hero_ref1.wav hero_ref2.wav ...

Per roll: median F0, jitter proxy (see voice-qa.py), P(male) from
alefiury/wav2vec2-large-xlsr-53-gender-recognition-librispeech, transcript match
(Whisper large-v3-turbo), and WavLM x-vector cosine similarity
(microsoft/wavlm-base-plus-sv) to each existing hero reference; ~0.86+ reads as
the same speaker. Runs on gpu-box in ~/vllm-omni/.venv. One JSON line per roll.
"""
import sys, json, re, difflib
import numpy as np, librosa, torch
from transformers import AutoFeatureExtractor, WavLMForXVector, AutoModelForAudioClassification, pipeline
expect = sys.argv[1]; split = sys.argv.index("--vs"); cands, heroes = sys.argv[2:split], sys.argv[split + 1:]
sv_fe = AutoFeatureExtractor.from_pretrained("microsoft/wavlm-base-plus-sv"); sv = WavLMForXVector.from_pretrained("microsoft/wavlm-base-plus-sv").eval()
G = "alefiury/wav2vec2-large-xlsr-53-gender-recognition-librispeech"; g_fe = AutoFeatureExtractor.from_pretrained(G); g = AutoModelForAudioClassification.from_pretrained(G).eval()
asr = pipeline("automatic-speech-recognition", model="openai/whisper-large-v3-turbo", device=0)
W = lambda s: re.findall(r"[a-z']+", s.lower())
def emb(y):
    with torch.no_grad(): return torch.nn.functional.normalize(sv(**sv_fe(y, sampling_rate=16000, return_tensors="pt")).embeddings, dim=-1)[0]
H = {h.split("/")[-1].split("_")[0]: emb(librosa.load(h, sr=16000)[0]) for h in heroes}
for c in cands:
    y, sr = librosa.load(c, sr=16000)
    f0, v, _ = librosa.pyin(y, fmin=60, fmax=400, sr=sr); f0 = f0[v & ~np.isnan(f0)]
    with torch.no_grad(): male = float(torch.softmax(g(**g_fe(y, sampling_rate=16000, return_tensors="pt")).logits, -1)[0][g.config.label2id["male"]])
    e = emb(y); sims = {k: round(float(e @ h), 2) for k, h in H.items()}
    text = asr({"raw": y, "sampling_rate": sr}, generate_kwargs={"language": "en"})["text"]
    print(json.dumps({"file": c.split("/")[-1], "f0": round(float(np.median(f0)), 1), "jit": round(float(np.median(np.abs(np.diff(f0)) / f0[1:]) * 100), 2),
        "male": round(male, 3), "max_sim": max(sims.values()), "sims": sims, "match": round(difflib.SequenceMatcher(None, W(expect), W(text)).ratio(), 2)}), flush=True)
