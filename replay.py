# -*- coding: utf-8 -*-
# replay.py — 폴더에 있는 일자별 CSV(예: DB/2025_01/*.csv)를
#             5초 간격으로 실시간처럼 WebSocket으로 브로드캐스트

import os, csv, glob, asyncio
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Iterable

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# =========================
# CONFIG (환경변수로 조정)
# =========================
CSV_DIR       = os.environ.get("CSV_DIR", "./DB/2025_01")   # CSV 폴더
CSV_GLOB      = os.environ.get("CSV_GLOB", "*.csv")         # 파일 패턴
CSV_ENCODING  = os.environ.get("CSV_ENCODING", "utf-8")     # euc-kr 등으로 변경 가능

LINE_FILTER   = os.environ.get("LINE_FILTER", "")           # 예: "1호기" (빈값=전체)
TOOL_FILTER   = os.environ.get("TOOL_FILTER", "")           # 예: "4242" (빈값=전체)

INTERVAL_SEC  = float(os.environ.get("INTERVAL_SEC", "5.0"))  # 기본 5초
SPEED_FACTOR  = float(os.environ.get("SPEED_FACTOR", "1.0"))  # 2.0이면 두배 빠름
LOOP_REPLAY   = os.environ.get("LOOP_REPLAY", "1") == "1"     # 끝나면 다시 처음부터

# CSV 컬럼명(네 파일 포맷에 맞춤)
COL_TIME = "TimeLine"
COL_LINE = "ProductionLine"
COL_TOOL = "Tool_Num"
COL_TROQ = "Troq"
COL_RPM  = "RPM"
COL_FEED = "Feed"

PREDICT_HOURS_START = 24   # 데모용 권고 창(시작)
PREDICT_HOURS_END   = 36   # 데모용 권고 창(끝)

# =========================
# FastAPI & Hub
# =========================
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"]
)

class Hub:
    def __init__(self):
        self.clients: List[WebSocket] = []
    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.clients.append(ws)
    def disconnect(self, ws: WebSocket):
        if ws in self.clients:
            self.clients.remove(ws)
    async def broadcast(self, msg: Dict[str, Any]):
        living = []
        for ws in self.clients:
            try:
                await ws.send_json(msg)
                living.append(ws)
            except Exception:
                pass
        self.clients = living

hub_line_1 = Hub()  # /lines/1 브로드캐스트 허브

# =========================
# CSV 유틸
# =========================
def _clean(v: Optional[str]) -> str:
    if v is None: return ""
    v = v.strip()
    if len(v) >= 2 and v[0] == "'" and v[-1] == "'":  # '2025-01-01 00:00:00' → 2025-01-01 00:00:00
        v = v[1:-1]
    return v

def _to_float(s: str, default: float = 0.0) -> float:
    try:
        return float(_clean(s).replace(",", ""))
    except Exception:
        return default

def parse_row(row: Dict[str, str]) -> Optional[Dict[str, Any]]:
    try:
        ts_s   = _clean(row.get(COL_TIME, ""))
        line   = _clean(row.get(COL_LINE, ""))
        tool_s = _clean(row.get(COL_TOOL, ""))

        if LINE_FILTER and line != LINE_FILTER:
            return None
        if TOOL_FILTER and tool_s != TOOL_FILTER:
            return None

        rpm  = _to_float(row.get(COL_RPM, "0"))
        feed = _to_float(row.get(COL_FEED, "0"))
        troq = _to_float(row.get(COL_TROQ, "0"))

        state = "cutting" if (rpm > 0 and (feed > 0 or troq > 0)) else "idle"

        ts = None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
            try:
                ts = datetime.strptime(ts_s, fmt); break
            except Exception:
                continue
        if ts is None:
            try:
                ts = datetime.fromisoformat(ts_s.replace("'", ""))
            except Exception:
                ts = datetime.utcnow()

        pred = {
            "replace_window": [
                (ts + timedelta(hours=PREDICT_HOURS_START)).isoformat(),
                (ts + timedelta(hours=PREDICT_HOURS_END)).isoformat()
            ]
        }

        return {
            "ts": ts.isoformat(),
            "line": line or "1호기",
            "tool_num": int(float(tool_s)) if tool_s else None,
            "rpm": rpm, "feed": feed, "troq": troq,
            "state": state,
            "prediction": pred
        }
    except Exception:
        return None

def list_csv_files_sorted(csv_dir: str, pattern: str) -> List[str]:
    paths = glob.glob(os.path.join(csv_dir, pattern))
    paths.sort()
    return paths

def iter_rows_from_files(files: List[str], encoding: str) -> Iterable[Dict[str, Any]]:
    for path in files:
        with open(path, "r", encoding=encoding, newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                msg = parse_row(row)
                if msg:
                    yield msg

# =========================
# 재생 루프
# =========================
async def replay_loop(hub: Hub):
    delay = max(0.01, INTERVAL_SEC / max(0.1, SPEED_FACTOR))
    files = list_csv_files_sorted(CSV_DIR, CSV_GLOB)
    if not files:
        print(f"[REPLAY] No CSV files found in {CSV_DIR}\\{CSV_GLOB}")
    else:
        print(f"[REPLAY] files: {len(files)}")
    while True:
        if not files:
            await asyncio.sleep(2.0); continue
        for msg in iter_rows_from_files(files, CSV_ENCODING):
            if not hub.clients:            # 시청자 없으면 대기만
                await asyncio.sleep(0.5);  continue
            await hub.broadcast(msg)
            await asyncio.sleep(delay)
        if not LOOP_REPLAY:
            break

# =========================
# FastAPI 엔드포인트
# =========================
@app.on_event("startup")
async def on_start():
    print(f"[REPLAY] DIR={CSV_DIR}, GLOB={CSV_GLOB}, ENC={CSV_ENCODING}")
    print(f"[REPLAY] INTERVAL_SEC={INTERVAL_SEC}, SPEED_FACTOR={SPEED_FACTOR}, LOOP={LOOP_REPLAY}")
    print(f"[REPLAY] FILTER line='{LINE_FILTER or 'ALL'}', tool='{TOOL_FILTER or 'ALL'}'")
    asyncio.create_task(replay_loop(hub_line_1))

@app.websocket("/lines/1")
async def ws_line_1(websocket: WebSocket):
    await hub_line_1.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # keep-alive
    except WebSocketDisconnect:
        hub_line_1.disconnect(websocket)
    except Exception:
        hub_line_1.disconnect(websocket)
