const WebSocket = require('ws');
const http = require('http');

// ================= CONFIG =================
const WS_URL = "wss://p6v9aiuvb60me.cq.qnwxdhwica.com/";
const PORT = 3000;
const WATCHDOG_SECONDS = 45;

// ================= DATA =================
let latestResult = null;
let lastSession = 0;
let ws = null;
let heartbeatInterval = null;
let watchdogTimer = null;
let reconnectTimer = null;
let lastResultTime = Date.now();
let isHandshakeDone = false;

const history = [];
const MAX_HISTORY = 100;

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

// ================= PREDICTION =================
function getPrediction() {
    if (history.length < 5) {
        return {
            du_doan: "CHỜ THÊM DỮ LIỆU",
            do_tin_cay: "THẤP",
            khuyen_nghi: "Chờ thêm dữ liệu"
        };
    }

    const recent = history.slice(0, 10);
    let tai = 0, xiu = 0;
    recent.forEach(i => {
        if (i.ket_qua === "TÀI") tai++;
        if (i.ket_qua === "XỈU") xiu++;
    });

    const last = recent[0]?.ket_qua;
    const prev = recent[1]?.ket_qua;

    let predict = "TÀI";
    let confidence = "THẤP";
    let advice = "Đánh nhẹ";

    if (last === prev && last) {
        predict = last;
        confidence = "CAO";
        advice = "Vào mạnh";
    } else {
        predict = last === "TÀI" ? "XỈU" : "TÀI";
        confidence = "TRUNG BÌNH";
        advice = "Cân nhắc";
    }

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

// ================= SAVE RESULT =================
function saveResult(session, dice1, dice2, dice3, hash) {
    if (!session) return;

    lastResultTime = Date.now();

    const total = dice1 + dice2 + dice3;
    let result = total > 10 ? "TÀI" : "XỈU";
    if (dice1 === dice2 && dice2 === dice3) result = "BÃO";

    const prediction = getPrediction();
    const now = new Date();
    const vnTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (7 * 3600000));
    const timeString = vnTime.toLocaleString("vi-VN", { hour12: false });

    latestResult = {
        app: "@tuanx3000",
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

    if (!history.some(item => item.phien === session)) {
        history.unshift({
            phien: session,
            ket_qua: result,
            tong: total,
            xuc_xac: [dice1, dice2, dice3],
            thoi_gian: timeString
        });
        if (history.length > MAX_HISTORY) history.pop();
    }

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

    // Clear old connection
    if (ws) {
        ws.removeAllListeners();
        ws.close();
        ws = null;
    }

    // Clear intervals and timeouts
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    // Reset handshake flag
    isHandshakeDone = false;

    try {
        ws = new WebSocket(WS_URL, {
            rejectUnauthorized: false,
            headers: {
                Origin: 'https://68gbvn88.bar',
                'User-Agent': 'Mozilla/5.0'
            }
        });
    } catch (err) {
        console.log("WS creation error:", err.message);
        reconnectTimer = setTimeout(connect, 3000);
        return;
    }

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

                        clearInterval(heartbeatInterval);
                        heartbeatInterval = setInterval(() => {
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(Buffer.from([0x03, 0x00, 0x00, 0x00]));
                            }
                        }, 3000);

                        setTimeout(() => ws.send(Buffer.from(PKT_AUTH, 'base64')), 500);
                        setTimeout(() => ws.send(Buffer.from(PKT_ENTER_ROOM, 'base64')), 1000);
                        setTimeout(() => ws.send(Buffer.from(PKT_GET_SCENE, 'base64')), 1500);
                        setTimeout(() => ws.send(Buffer.from(PKT_REQ_HISTORY, 'base64')), 2000);

                        clearInterval(watchdogTimer);
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

    ws.on('close', (code, reason) => {
        console.log(`❌ Disconnected - code: ${code}, reason: ${String(reason)}`);
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        clearInterval(watchdogTimer);
        watchdogTimer = null;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
        console.log("WS Error:", err.message);
        if (ws) {
            ws.close(); // trigger close event for reconnect
        }
    });
}

// ================= HTTP SERVER =================
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.url === '/taixiumd5') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: "success",
            app: "@tuanx3000",
            data: latestResult
        }, null, 2));
    } else if (req.url === '/history') {
        res.writeHead(200);
        res.end(JSON.stringify({
            app: "@tuanx3000",
            total: history.length,
            history: history
        }, null, 2));
    } else if (req.url === '/stats') {
        const tai = history.filter(item => item.ket_qua === "TÀI").length;
        const xiu = history.filter(item => item.ket_qua === "XỈU").length;
        const bao = history.filter(item => item.ket_qua === "BÃO").length;
        res.writeHead(200);
        res.end(JSON.stringify({
            app: "@tuanx3000",
            total: history.length,
            tai: tai,
            xiu: xiu,
            bao: bao,
            last_update: latestResult?.thoi_gian || null
        }, null, 2));
    } else {
        res.writeHead(404);
        res.end(JSON.stringify({
            error: "Not found",
            endpoints: ["/taixiumd5", "/history", "/stats"]
        }, null, 2));
    }
});

// ================= START =================
console.clear();
console.log("🔴 68GB TÀI XỈU MD5 (SỬA LỖI)");
console.log(`🌐 API: http://localhost:${PORT}/taixiumd5`);
console.log(`📜 HISTORY: http://localhost:${PORT}/history`);
console.log(`📊 STATS: http://localhost:${PORT}/stats`);
console.log("====================================");

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    connect();
});

// Bắt lỗi uncaught để tránh crash
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED]', reason);
});