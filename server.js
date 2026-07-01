const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// ================= CONFIG =================
const WS_URL = "wss://p6v9aiuvb60me.cq.qnwxdhwica.com/";
const PORT = process.env.PORT || 3000;
const WATCHDOG_SECONDS = 45;
const MAX_HISTORY = 200;
const APP_NAME = "tuanx3000";

// ================= DATA =================
let latestResult = null;
let lastSession = 0;
let ws = null;
let heartbeatInterval = null;
let watchdogTimer = null;
let lastResultTime = Date.now();
let isHandshakeDone = false;

const history = [];

// ================= PACKETS =================
const GAME_END_ROUTE = Buffer.from('mnmdsbgameend');
const GAME_START_ROUTE = Buffer.from('mnmdsbgamestart');

const PKT_AUTH = 'BAAATQEEAAEIAhDKARpAMWZkNDcwMTdlZDE1NGVhMzgyMGQ0ZjZmZmEyODg1NTMxM2ZlMTY4NDIwZDk0OWI2YWY0ZWQxYjllZDI2ZWEzYUIA';
const PKT_ENTER_ROOM = 'BAAAJQAFIm1ubWRzYi5tbm1kc2JoYW5kbGVyLmVudGVyZ2FtZXJvb20=';
const PKT_GET_SCENE = 'BAAAJAAGIW1ubWRzYi5tbm1kc2JoYW5kbGVyLmdldGdhbWVzY2VuZQ==';
const PKT_REQ_HISTORY = 'BAAAJAAHIW1ubWRzYi5tbm1kc2JoYW5kbGVyLnJlcXBva2VyaW5mbw==';

// ================= TOOL FUNCTIONS =================
function findRouteEnd(buf, route) {
    for (let i = 4; i < buf.length - route.length; i++) {
        let found = true;
        for (let j = 0; j < route.length; j++) {
            if (buf[i + j] !== route[j]) {
                found = false;
                break;
            }
        }
        if (found) return i + route.length;
    }
    return -1;
}

function extractMD5Hash(pack, startOffset) {
    let offset = startOffset;
    try {
        while (offset < pack.length - 34) {
            let possible = true;
            for (let k = 0; k < 32; k++) {
                const c = pack[offset + k];
                if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) {
                    possible = false;
                    break;
                }
            }
            if (possible) {
                return Buffer.from(pack.slice(offset, offset + 32)).toString('utf8');
            }
            offset++;
        }
    } catch (e) {}
    return "";
}

function readVarint(bytes, offset) {
    let result = 0;
    let shift = 0;
    while (offset < bytes.length) {
        let b = bytes[offset++];
        result |= (b & 0x7F) << shift;
        if (!(b & 0x80)) {
            return { value: result, newOffset: offset };
        }
        shift += 7;
    }
    return { value: result, newOffset: offset };
}

// ================= PREDICTION (dựa trên Tài/Xỉu thuần, không Bão) =================
function getPrediction() {
    if (history.length < 5) {
        return {
            du_doan: "CHỜ THÊM DỮ LIỆU",
            do_tin_cay: "THẤP",
            khuyen_nghi: "Chờ ít nhất 5 phiên"
        };
    }

    const recent = history.slice(0, 10);
    let tai = 0, xiu = 0;
    recent.forEach(item => {
        if (item.ket_qua === "TÀI") tai++;
        else if (item.ket_qua === "XỈU") xiu++;
    });

    const last = recent[0]?.ket_qua;
    const prev = recent[1]?.ket_qua;

    let predict = "TÀI";
    let confidence = "TRUNG BÌNH";
    let advice = "Cân nhắc";

    if (last && prev && last === prev) {
        predict = last;
        confidence = "CAO";
        advice = "Vào mạnh";
    } else if (last && prev && last !== prev) {
        predict = last === "TÀI" ? "XỈU" : "TÀI";
        confidence = "TRUNG BÌNH";
        advice = "Đánh nhẹ";
    }

    // Xu hướng dài hạn
    if (tai >= 7) {
        predict = "TÀI";
        confidence = "CAO";
        advice = "Vào mạnh";
    } else if (xiu >= 7) {
        predict = "XỈU";
        confidence = "CAO";
        advice = "Vào mạnh";
    }

    return { du_doan: predict, do_tin_cay: confidence, khuyen_nghi: advice };
}

// ================= SAVE RESULT (chỉ Tài/Xỉu, không Bão) =================
function saveResult(session, dice1, dice2, dice3, hash) {
    if (!session) return;
    if (history.some(item => item.phien === session)) return;

    lastResultTime = Date.now();

    const total = dice1 + dice2 + dice3;
    // Xỉu: 3-10, Tài: 11-18
    const result = total >= 11 ? "TÀI" : "XỈU";

    const prediction = getPrediction();
    const now = new Date();
    const vnTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (7 * 3600000));
    const timeString = vnTime.toISOString().replace('T', ' ').slice(0, 19);

    latestResult = {
        app: APP_NAME,
        phien: session,
        xuc_xac: [dice1, dice2, dice3],
        tong: total,
        ket_qua: result,
        md5: hash || "",
        du_doan: prediction.du_doan,
        do_tin_cay: prediction.do_tin_cay,
        khuyen_nghi: prediction.khuyen_nghi,
        thoi_gian: timeString
    };

    history.unshift({
        phien: session,
        ket_qua: result,
        tong: total,
        xuc_xac: [dice1, dice2, dice3],
        thoi_gian: timeString,
        md5: hash || ""
    });

    if (history.length > MAX_HISTORY) history.pop();

    console.log(`🎲 Phiên #${session} | ${dice1}-${dice2}-${dice3} | ${result} | Dự đoán: ${prediction.du_doan}`);
}

// ================= PROCESS POMELO PACKET =================
function processPomeloPacket(pack) {
    if (pack.length < 5) return;

    let routeEnd = findRouteEnd(pack, GAME_END_ROUTE);
    if (routeEnd < 0) {
        routeEnd = findRouteEnd(pack, GAME_START_ROUTE);
    }
    if (routeEnd < 0) return;

    let offset = routeEnd;
    let foundSession = 0;
    let diceArr = [];
    const md5Hash = extractMD5Hash(pack, routeEnd);

    try {
        while (offset < pack.length) {
            const info = readVarint(pack, offset);
            if (info.newOffset >= pack.length) break;
            const wireType = info.value & 7;
            offset = info.newOffset;

            if (wireType === 0) {
                const v = readVarint(pack, offset);
                offset = v.newOffset;
                if (v.value >= 10000 && v.value <= 99999 && foundSession === 0) {
                    foundSession = v.value;
                }
            } else if (wireType === 2) {
                const lenInfo = readVarint(pack, offset);
                const len = lenInfo.value;
                offset = lenInfo.newOffset;
                if (len === 3 && diceArr.length === 0) {
                    const v1 = pack[offset];
                    const v2 = pack[offset + 1];
                    const v3 = pack[offset + 2];
                    if (v1 >= 1 && v1 <= 12 && v2 >= 1 && v2 <= 12 && v3 >= 1 && v3 <= 12) {
                        // Giá trị có thể bị nhân đôi, chia nếu cần
                        const doubled = (v1 % 2 === 0 && v2 % 2 === 0 && v3 % 2 === 0);
                        diceArr = doubled ? [v1 / 2, v2 / 2, v3 / 2] : [v1, v2, v3];
                    }
                }
                offset += len;
            } else if (wireType === 1) {
                offset += 8;
            } else if (wireType === 5) {
                offset += 4;
            } else {
                break;
            }
        }
    } catch (e) {
        console.log('Parse error:', e.message);
    }

    if (foundSession > 0 && diceArr.length === 3 && foundSession !== lastSession) {
        lastSession = foundSession;
        saveResult(foundSession, diceArr[0], diceArr[1], diceArr[2], md5Hash);
    }
}

// ================= WEBSOCKET =================
function connect() {
    console.log("🌐 Đang kết nối WebSocket...");

    ws = new WebSocket(WS_URL, {
        rejectUnauthorized: false,
        headers: {
            Origin: 'https://68gbvn88.bar',
            'User-Agent': 'Mozilla/5.0'
        }
    });

    ws.on('open', () => {
        console.log("✅ Connected");
        ws.send(Buffer.from(
            'AQAAcnsic3lzIjp7InBsYXRmb3JtIjoianMtd2Vic29ja2V0IiwiY2xpZW50QnVpbGROdW1iZXIiOiIwLjAuMSIsImNsaWVudFZlcnNpb24iOiIwYTIxNDgxZDc0NmY5MmY4NDI4ZTFiNmRlZWI3NmZlYSJ9fQ==',
            'base64'
        ));
        isHandshakeDone = false;
    });

    ws.on('message', (data) => {
        try {
            const buffer = new Uint8Array(data);
            let offset = 0;

            while (offset < buffer.length) {
                const pkgType = buffer[offset];
                const length = (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
                const pack = buffer.slice(offset, offset + 4 + length);
                offset += 4 + length;

                if (pkgType === 1) {
                    if (!isHandshakeDone) {
                        isHandshakeDone = true;
                        console.log("🤝 Handshake OK");
                        ws.send(Buffer.from([0x02, 0x00, 0x00, 0x00]));

                        if (heartbeatInterval) clearInterval(heartbeatInterval);
                        heartbeatInterval = setInterval(() => {
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(Buffer.from([0x03, 0x00, 0x00, 0x00]));
                            }
                        }, 3000);

                        setTimeout(() => ws.send(Buffer.from(PKT_AUTH, 'base64')), 500);
                        setTimeout(() => ws.send(Buffer.from(PKT_ENTER_ROOM, 'base64')), 1000);
                        setTimeout(() => ws.send(Buffer.from(PKT_GET_SCENE, 'base64')), 1500);
                        setTimeout(() => ws.send(Buffer.from(PKT_REQ_HISTORY, 'base64')), 2000);

                        if (watchdogTimer) clearInterval(watchdogTimer);
                        watchdogTimer = setInterval(() => {
                            const elapsed = Math.round((Date.now() - lastResultTime) / 1000);
                            if (elapsed >= WATCHDOG_SECONDS) {
                                console.log("⚠️ Timeout – reconnecting...");
                                if (ws) ws.terminate();
                            }
                        }, 5000);
                    }
                } else if (pkgType === 3) {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(Buffer.from([0x03, 0x00, 0x00, 0x00]));
                    }
                } else if (pkgType === 4) {
                    processPomeloPacket(pack);
                }
            }
        } catch (e) {
            console.log('Message error:', e.message);
        }
    });

    ws.on('close', () => {
        console.log("❌ Disconnected");
        clearInterval(heartbeatInterval);
        clearInterval(watchdogTimer);
        setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
        console.log("WS Error:", err.message);
        if (ws) ws.terminate();
    });
}

// ================= HTTP SERVER =================
const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const path = parsed.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (path === '/api/result') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: "success",
            app: APP_NAME,
            data: latestResult
        }, null, 2));
    }
    else if (path === '/api/history') {
        const limit = parseInt(parsed.query.limit) || 20;
        res.writeHead(200);
        res.end(JSON.stringify({
            app: APP_NAME,
            total: history.length,
            history: history.slice(0, limit)
        }, null, 2));
    }
    else if (path === '/api/stats') {
        const tai = history.filter(item => item.ket_qua === "TÀI").length;
        const xiu = history.filter(item => item.ket_qua === "XỈU").length;
        res.writeHead(200);
        res.end(JSON.stringify({
            app: APP_NAME,
            total: history.length,
            tai: tai,
            xiu: xiu,
            tai_percent: history.length ? ((tai / history.length) * 100).toFixed(2) : 0,
            xiu_percent: history.length ? ((xiu / history.length) * 100).toFixed(2) : 0,
            last_update: latestResult?.thoi_gian || null
        }, null, 2));
    }
    else if (path === '/api/predict') {
        const prediction = getPrediction();
        res.writeHead(200);
        res.end(JSON.stringify({
            app: APP_NAME,
            prediction: prediction,
            based_on: Math.min(history.length, 10),
            timestamp: new Date().toISOString()
        }, null, 2));
    }
    else if (path === '/api/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            app: APP_NAME,
            status: "online",
            websocket: ws ? ws.readyState === WebSocket.OPEN : false,
            connected: ws ? ws.readyState === WebSocket.OPEN : false,
            last_result: latestResult?.thoi_gian || null,
            history_count: history.length,
            uptime: process.uptime().toFixed(0) + 's'
        }, null, 2));
    }
    else if (path === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const html = buildDashboard();
        res.writeHead(200);
        res.end(html);
    }
    else {
        res.writeHead(404);
        res.end(JSON.stringify({
            error: "Not found",
            endpoints: ["/api/result", "/api/history", "/api/stats", "/api/predict", "/api/status", "/"]
        }, null, 2));
    }
});

// ================= BUILD DASHBOARD =================
function buildDashboard() {
    const latest = latestResult || {};
    const recent = history.slice(0, 5);

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${APP_NAME} - Tài Xỉu MD5</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Segoe UI',Arial,sans-serif; background:#0b0e14; color:#e0e0e0; padding:20px; }
        .container { max-width:1200px; margin:0 auto; }
        .header { text-align:center; padding:30px; background:linear-gradient(145deg,#1a1f2b,#0d1117); border-radius:20px; margin-bottom:30px; border:1px solid #2a3344; }
        .header h1 { font-size:2.8rem; background:linear-gradient(90deg,#f7971e,#ffd200); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
        .grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-bottom:24px; }
        .card { background:#141a24; border-radius:16px; padding:24px; border:1px solid #26303e; }
        .card h2 { color:#99aacd; margin-bottom:16px; font-size:1.2rem; }
        .dice-row { display:flex; gap:16px; justify-content:center; margin:12px 0; }
        .dice { width:70px; height:70px; background:#1e2838; border-radius:16px; display:flex; align-items:center; justify-content:center; font-size:2.2rem; font-weight:700; border:2px solid #2f405a; }
        .dice.tai { border-color:#f7b731; background:#2a2a1a; color:#f7b731; }
        .dice.xiu { border-color:#e74c3c; background:#2a1a1a; color:#e74c3c; }
        .result-text { font-size:2rem; font-weight:800; text-align:center; margin:8px 0; }
        .result-text.tai { color:#f7b731; }
        .result-text.xiu { color:#e74c3c; }
        .info-line { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #1e2838; }
        .stats-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:12px; }
        .stat-item { text-align:center; background:#0f151f; padding:12px; border-radius:12px; border:1px solid #1e2838; }
        .stat-item .num { font-size:1.8rem; font-weight:700; }
        .stat-item .label { font-size:0.85rem; color:#8899bb; }
        table { width:100%; border-collapse:collapse; }
        th { text-align:left; padding:10px 6px; border-bottom:2px solid #26303e; color:#8899bb; }
        td { padding:10px 6px; border-bottom:1px solid #1e2838; }
        .tai { color:#f7b731; }
        .xiu { color:#e74c3c; }
        .footer { text-align:center; margin-top:30px; color:#3e5068; }
        @media (max-width:768px) { .grid { grid-template-columns:1fr; } }
        .badge { display:inline-block; padding:4px 12px; border-radius:20px; background:#1e2a3a; font-size:0.85rem; color:#aabbdd; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>🎲 ${APP_NAME} - Tài Xỉu MD5</h1>
        <p>Xỉu (3-10) · Tài (11-18) · Dữ liệu thời gian thực</p>
        <div class="badge">🔴 Online · Phiên hiện tại: ${latest.phien || 'N/A'}</div>
    </div>

    <div class="grid">
        <div class="card">
            <h2>🎯 Kết quả mới nhất</h2>
            <div class="dice-row">
                <div class="dice ${latest.ket_qua ? latest.ket_qua.toLowerCase() : ''}">${latest.xuc_xac?.[0] || '?'}</div>
                <div class="dice ${latest.ket_qua ? latest.ket_qua.toLowerCase() : ''}">${latest.xuc_xac?.[1] || '?'}</div>
                <div class="dice ${latest.ket_qua ? latest.ket_qua.toLowerCase() : ''}">${latest.xuc_xac?.[2] || '?'}</div>
            </div>
            <div class="result-text ${latest.ket_qua ? latest.ket_qua.toLowerCase() : ''}">
                ${latest.tong ? `${latest.tong} (${latest.ket_qua})` : 'Đang chờ...'}
            </div>
            <div class="info-line"><span>Phiên</span><span>${latest.phien || 'N/A'}</span></div>
            <div class="info-line"><span>MD5</span><span style="font-size:0.8rem;">${latest.md5 || 'N/A'}</span></div>
            <div class="info-line"><span>Thời gian</span><span>${latest.thoi_gian || 'N/A'}</span></div>
            <div class="info-line"><span>Dự đoán</span><span>${latest.du_doan || 'N/A'} (${latest.do_tin_cay || ''})</span></div>
            <div class="info-line"><span>Khuyến nghị</span><span>${latest.khuyen_nghi || ''}</span></div>
        </div>

        <div class="card">
            <h2>📊 Thống kê & Dự đoán</h2>
            <div id="stats-container" class="stats-grid">
                <div class="stat-item"><div class="num" id="st-total">0</div><div class="label">Tổng</div></div>
                <div class="stat-item"><div class="num" id="st-tai" style="color:#f7b731;">0</div><div class="label">Tài</div></div>
                <div class="stat-item"><div class="num" id="st-xiu" style="color:#e74c3c;">0</div><div class="label">Xỉu</div></div>
            </div>
            <div style="margin-top:16px; background:#0f151f; padding:12px; border-radius:12px;">
                <div><strong>Dự đoán tiếp theo:</strong> <span id="predict-text">Đang tính...</span></div>
                <div><strong>Độ tin cậy:</strong> <span id="confidence-text">--</span></div>
                <div><strong>Khuyến nghị:</strong> <span id="advice-text">--</span></div>
            </div>
        </div>
    </div>

    <div class="card" style="margin-bottom:24px;">
        <h2>📜 Lịch sử (10 phiên gần nhất)</h2>
        <table>
            <thead><tr><th>Phiên</th><th>Kết quả</th><th>Thời gian</th></tr></thead>
            <tbody id="history-body">
                ${recent.map(item => `
                    <tr>
                        <td>${item.phien}</td>
                        <td class="${item.ket_qua.toLowerCase()}">${item.xuc_xac.join('-')} = ${item.tong} (${item.ket_qua})</td>
                        <td>${item.thoi_gian}</td>
                    </tr>
                `).join('')}
                ${recent.length === 0 ? '<tr><td colspan="3" style="text-align:center;color:#556;">Chưa có dữ liệu</td></tr>' : ''}
            </tbody>
        </table>
    </div>

    <div class="card">
        <h2>🔗 API Endpoints</h2>
        <ul style="list-style:none; display:flex; flex-wrap:wrap; gap:12px;">
            <li><a href="/api/result" style="color:#66c7ff;">/api/result</a></li>
            <li><a href="/api/history?limit=10" style="color:#66c7ff;">/api/history</a></li>
            <li><a href="/api/stats" style="color:#66c7ff;">/api/stats</a></li>
            <li><a href="/api/predict" style="color:#66c7ff;">/api/predict</a></li>
            <li><a href="/api/status" style="color:#66c7ff;">/api/status</a></li>
        </ul>
    </div>

    <div class="footer">Powered by <strong>${APP_NAME}</strong> · Dữ liệu cập nhật mỗi 5 giây</div>
</div>

<script>
    function fetchData() {
        fetch('/api/result')
            .then(r => r.json())
            .then(res => {
                const data = res.data;
                if (data && data.phien) {
                    const diceEls = document.querySelectorAll('.dice');
                    diceEls.forEach((el, i) => el.textContent = data.xuc_xac?.[i] || '?');
                    const cls = data.ket_qua ? data.ket_qua.toLowerCase() : '';
                    diceEls.forEach(el => el.className = 'dice ' + cls);
                    const resultText = document.querySelector('.result-text');
                    resultText.textContent = data.tong + ' (' + data.ket_qua + ')';
                    resultText.className = 'result-text ' + cls;
                    document.querySelectorAll('.info-line span')[1].textContent = data.phien || 'N/A';
                    document.querySelectorAll('.info-line span')[3].textContent = data.md5 || 'N/A';
                    document.querySelectorAll('.info-line span')[5].textContent = data.thoi_gian || 'N/A';
                    document.querySelectorAll('.info-line span')[7].textContent = (data.du_doan || 'N/A') + ' (' + (data.do_tin_cay || '') + ')';
                    document.querySelectorAll('.info-line span')[9].textContent = data.khuyen_nghi || '';
                    document.querySelector('.badge').textContent = '🔴 Online · Phiên hiện tại: ' + data.phien;
                }
            })
            .catch(e => console.error(e));

        fetch('/api/stats')
            .then(r => r.json())
            .then(stats => {
                document.getElementById('st-total').textContent = stats.total || 0;
                document.getElementById('st-tai').textContent = stats.tai || 0;
                document.getElementById('st-xiu').textContent = stats.xiu || 0;
            })
            .catch(e => console.error(e));

        fetch('/api/predict')
            .then(r => r.json())
            .then(res => {
                const pred = res.prediction;
                document.getElementById('predict-text').textContent = pred.du_doan || '--';
                document.getElementById('confidence-text').textContent = pred.do_tin_cay || '--';
                document.getElementById('advice-text').textContent = pred.khuyen_nghi || '--';
            })
            .catch(e => console.error(e));

        fetch('/api/history?limit=10')
            .then(r => r.json())
            .then(res => {
                const tbody = document.getElementById('history-body');
                tbody.innerHTML = res.history.map(item => `
                    <tr>
                        <td>${item.phien}</td>
                        <td class="${item.ket_qua.toLowerCase()}">${item.xuc_xac.join('-')} = ${item.tong} (${item.ket_qua})</td>
                        <td>${item.thoi_gian}</td>
                    </tr>
                `).join('');
                if (res.history.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#556;">Chưa có dữ liệu</td></tr>';
                }
            })
            .catch(e => console.error(e));
    }

    fetchData();
    setInterval(fetchData, 5000);
</script>
</body>
</html>
    `;
}

// ================= START =================
console.clear();
console.log(`🔴 ${APP_NAME} - TÀI XỈU MD5 (XỈU 3-10, TÀI 11-18)`);
console.log(`🌐 API: http://localhost:${PORT}/api/result`);
console.log(`📜 HISTORY: http://localhost:${PORT}/api/history`);
console.log(`📊 STATS: http://localhost:${PORT}/api/stats`);
console.log(`🤖 PREDICT: http://localhost:${PORT}/api/predict`);
console.log(`📋 STATUS: http://localhost:${PORT}/api/status`);
console.log(`🌍 DASHBOARD: http://localhost:${PORT}/`);
console.log("====================================");

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    connect();
});
