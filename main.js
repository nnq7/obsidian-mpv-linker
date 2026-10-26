'use strict';















































const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const {
    Platform,
    Plugin,
    PluginSettingTab,
    Setting,
    Notice,
    TFolder,
    normalizePath,
    AbstractInputSuggest,
    editorLivePreviewField,
} = require('obsidian');





const { ViewPlugin, Decoration, WidgetType } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');





const DEFAULT_SETTINGS = {
    videoDirectory: '',
    mpvPath: 'mpvnet',
    videoExtensions: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm'],
    





    mpvExtraArgs: '',
    



    mpvIpcBase: 18730,
    




    snapshotResolution: 'none',
    






    snapshotQuality: 90,
    



    snapshotFolder: '',
};

const PLAY_NOTICE_MS = 3000;








const IPC_SLOT_COUNT = 8;
const INPIPE_ROOT = '\\\\.\\pipe\\';
const PIPE_PREFIX = 'mpv-linker-';


const NO_MPV_MESSAGE = '未获取到mpv.net视频，请检查mpv.net是否有视频正在播放！';





const WINDOW_NOT_CAPTURED_MESSAGE = '窗口获取失败！只有通过笔记链接打开的mpv.net视频窗口才能被捕获！';


const NO_IPC_MESSAGE = '插入需要 mpv.net 的远程接口，请把「复用窗口通道」设为非 0';


const LINK_EXISTS_MESSAGE = '无法插入，当前位置已存在视频链接！';






const ALREADY_PLAYING_MESSAGE = '已有同名视频正在播放！';





const DURATION_EXCEEDED_MESSAGE = '该时间点超出视频总时长！';





const DELETE_HINT_MESSAGE = '请在视频链接上右键选择删除！';





const KEYWORD_BAD = /[{}&|\n]/;






const SKIP_SELECTOR = 'pre, code, a';

















const TIMING = {
    ipcTimeout: 700,
    pollMs: 150,
    launchRetryMs: 1500,
    launchFreshMs: 10000,
    snapTimeoutMs: 15000,
    snapPollMs: 100,
    snapStableMs: 250,
    snapExitGraceMs: 2000,
};





























const SNAP_ROOT = path.join(os.tmpdir(), 'mpv-linker-snap', String(process.pid));


const SNAP_FORMAT = 'jpg';














const SNAP_IMAGE_NAME = /^\d+\.(?:jpg|jpeg)$/i;


const SNAP_PX_1K = 1920 * 1080;

const SNAP_PX_2K = 2560 * 1440;









const SNAP_PX_TARGET = { none: 0, '2k': SNAP_PX_2K, '1k': SNAP_PX_1K };

const SNAP_RESOLUTION_OPTIONS = {
    none: '不操作，按原始分辨率截图',
    '2k': '缩放到2k(宽2560)',
    '1k': '缩放到1k(宽1920)',
};


const SNAP_NAME_MAX = 24;



const snapShortName = (keyword) => [...keyword].slice(0, SNAP_NAME_MAX).join('');

const SNAP_NAME_BAD = /[\\/:*?"<>|]/g;


const FILM_ICON = 'film';
const CLOCK_ICON = 'clock';
const SCISSORS_ICON = 'scissors';
const CAMERA_ICON = 'camera';
const FOLDER_ICON = 'folder-open';


const SNAP_TIME_ONLY_MESSAGE = '请在时间节点上操作！';
const SNAP_NO_PLAYING_MESSAGE = '截图失败，请检查mpv.net是否有视频正在播放';

const SNAP_NO_IMAGE_MESSAGE = '截图失败：mpv.net 没有写出图片';


const SNAP_SAVE_FAILED_MESSAGE = '截图失败：图片没能写进仓库';

const SNAP_FOLDER_MISSING_MESSAGE = '截图保存目录不存在';



const NOTICE_PREFIX = 'MPV Linker：';


const notice = (msg, timeout) => new Notice(NOTICE_PREFIX + msg, timeout);

const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));


const fileExists = (p) => fs.promises.access(p).then(() => true, () => false);









function waitForExit(child, ms) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode != null) return resolve();

        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            resolve();
        };
        const timer = window.setTimeout(done, ms);
        child.once('exit', done);
        child.once('close', done);
        child.once('error', done);
    });
}







const createLinkRegex = () =>
    /\{@([^}&\n|]+?)(?:&((?:\d{1,2}:\d{2}(?::\d{2})?)(?:\|\d{1,2}:\d{2}(?::\d{2})?)*))?\}/g;


const splitTimes = (t) => (t ? t.split('|') : []);


function parseTimeToSeconds(t) {
    let s = 0;
    if (t) for (const n of t.split(':')) s = s * 60 + (Number(n) || 0);
    return s;
}

const buildTooltip = (k, times) =>
    times.length ? `mpv.net 播放：${k} @ ${times.join(' / ')}` : `mpv.net 播放：${k}`;





function formatTime(seconds) {
    const t = Math.max(0, Math.floor(Number(seconds) || 0));
    const pad = (n) => String(n).padStart(2, '0');
    return (
        (t >= 3600 ? Math.floor(t / 3600) + ':' : '') +
        pad(Math.floor((t % 3600) / 60)) +
        ':' +
        pad(t % 60)
    );
}


const keywordOf = (file) => path.basename(file, path.extname(file));








function normalizeExtensions(list) {
    const out = [];
    for (const raw of list) {
        const s = String(raw ?? '').trim().toLowerCase();
        if (s) out.push(s[0] === '.' ? s : '.' + s);
    }
    return out;
}












function parseExtraArgs(text) {
    return [...text.matchAll(/(?:[^\s"]|"[^"]*")+/g)].map((m) =>
        m[0].replace(/"([^"]*)"/g, '$1')
    );
}

















function buildLinkDom(keyword, times, onPlay, onContextMenu) {
    const wrap = document.createElement('span');
    wrap.className = 'mpv-linker-link';
    wrap.setAttribute('role', 'button');
    wrap.title = buildTooltip(keyword, times);

    
    
    wrap.addEventListener('mousedown', (e) => e.preventDefault());
    wrap.addEventListener('click', (e) => {
        e.preventDefault();
        
        onPlay(times[0] ?? '', true);
    });
    if (onContextMenu) {
        wrap.addEventListener('contextmenu', (e) => {
            
            
            const el = e.target.closest('.mpv-linker-time');
            onContextMenu(el ? el.mpvLinkerTime : -1);
        });
    }

    wrap.appendChild(document.createTextNode(`(🎞${keyword}${times.length ? '-' : ''}`));
    times.forEach((t, i) => {
        if (i) wrap.appendChild(document.createTextNode('|'));
        const el = document.createElement('span');
        el.className = 'mpv-linker-time';
        el.setAttribute('role', 'button');
        el.textContent = t;
        el.mpvLinkerTime = i; 
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation(); 
            
            onPlay(t, false);
        });
        wrap.appendChild(el);
    });
    wrap.appendChild(document.createTextNode(')'));

    return wrap;
}





class MpvLinkWidget extends WidgetType {
    constructor(keyword, times, plugin, from = -1, to = -1) {
        super();
        this.keyword = keyword;
        this.times = times;
        this.plugin = plugin;
        this.from = from; 
        this.to = to;
    }

    eq(other) {
        return (
            other.keyword === this.keyword &&
            other.times.join() === this.times.join() &&
            
            other.from === this.from &&
            other.to === this.to
        );
    }

    toDOM() {
        return buildLinkDom(
            this.keyword,
            this.times,
            (t, isKeywordClick) => this.plugin.playVideo(this.keyword, t, isKeywordClick),
            (timeIndex) => this.plugin.rememberLink(this.from, this.to, timeIndex)
        );
    }
}














const BLANK_REST = /^[ \t]*$/;


const lineEndAt = (text, i) => {
    const nl = text.indexOf('\n', i);
    return nl < 0 ? text.length : nl;
};


function fenceAt(text, start, stop) {
    let from = start;
    while (from < stop && from - start < 3 && text[from] === ' ') from++;

    const ch = text[from];
    if (ch !== '`' && ch !== '~') return null;

    let end = from;
    while (end < stop && text[end] === ch) end++;
    return end - from >= 3 ? { ch, len: end - from, from } : null;
}





function fenceEnd(text, from, fence) {
    const n = text.length;
    for (let i = from; i < n; ) {
        const stop = lineEndAt(text, i);
        const close = fenceAt(text, i, stop);
        if (
            close &&
            close.ch === fence.ch &&
            close.len >= fence.len &&
            BLANK_REST.test(text.slice(close.from + close.len, stop))
        ) {
            return stop;
        }
        i = stop + 1;
    }
    return n;
}





function findBacktickRun(text, from, len) {
    const n = text.length;
    for (let i = from; i < n; ) {
        if (text[i] !== '`') {
            if (text[i] === '\n' && BLANK_REST.test(text.slice(i + 1, lineEndAt(text, i + 1)))) {
                return -1;
            }
            i++;
            continue;
        }
        let end = i;
        while (end < n && text[end] === '`') end++;
        if (end - i === len) return i;
        i = end;
    }
    return -1;
}


function scanInline(text, from, stop, out) {
    let i = from;
    while (i < stop) {
        if (text[i] === '`') {
            let len = 0;
            while (text[i + len] === '`') len++;
            const close = findBacktickRun(text, i + len, len);
            if (close < 0) {
                i += len; 
                continue;
            }
            out.push({ from: i, to: close + len });
            i = close + len;
            continue;
        }
        if (text[i] === '%' && text[i + 1] === '%') {
            
            const close = text.indexOf('%%', i + 2);
            const to = close < 0 ? text.length : close + 2;
            out.push({ from: i, to });
            i = to;
            continue;
        }
        i++;
    }
    return i;
}


function findBlocked(text) {
    const out = [];
    const n = text.length;

    for (let i = 0; i < n; ) {
        const stop = lineEndAt(text, i);

        
        if (i === 0 || text[i - 1] === '\n') {
            const fence = fenceAt(text, i, stop);
            if (fence) {
                const end = fenceEnd(text, stop + 1, fence);
                out.push({ from: i, to: end });
                i = end;
                continue;
            }
        }

        const next = scanInline(text, i, stop, out);
        i = next > stop ? next : stop + 1; 
    }
    return out;
}










function scanTextLinks(text) {
    
    if (!text.includes('{@')) return [];

    const blocked = findBlocked(text);
    const out = [];
    const re = createLinkRegex();
    let b = 0;

    for (let m; (m = re.exec(text)); ) {
        const to = m.index + m[0].length;
        
        while (b < blocked.length && blocked[b].to <= m.index) b++;
        if (b < blocked.length && blocked[b].from < to) continue; 
        out.push({ from: m.index, to, keyword: m[1], times: splitTimes(m[2]) });
    }
    return out;
}

const scanLinks = (state) => scanTextLinks(state.doc.toString());





const touches = (link, sel) => sel.from <= link.to && sel.to >= link.from;

const touchesAny = (links, sel) => links.some((l) => touches(l, sel));


const sameRange = (link, hint) => link.from === hint.from && link.to === hint.to;






function timeRangesAt(from, keyword, times) {
    let at = from + 2 + keyword.length;
    return times.map((t) => {
        at += 1; 
        const range = { from: at, to: at + t.length };
        at += t.length;
        return range;
    });
}






const timeIndexAt = (ranges, sel) => ranges.findIndex((r) => sel.from < r.to && sel.to >= r.from);


const linkTextWithoutTime = (link, index) => {
    const times = link.times.filter((_, i) => i !== index);
    return times.length ? `{@${link.keyword}&${times.join('|')}}` : `{@${link.keyword}}`;
};






const linkTextWithTime = (link, time) => {
    const times = [...link.times, time].sort(
        (a, b) => parseTimeToSeconds(a) - parseTimeToSeconds(b)
    );
    return `{@${link.keyword}&${times.join('|')}}`;
};

function buildDecorations(links, sel, plugin) {
    const builder = new RangeSetBuilder();
    for (const l of links) {
        if (touches(l, sel)) continue; 
        builder.add(
            l.from,
            l.to,
            Decoration.replace({
                widget: new MpvLinkWidget(l.keyword, l.times, plugin, l.from, l.to),
            })
        );
    }
    return builder.finish();
}















const pipePathOf = (name) => INPIPE_ROOT + name;

const pipeNameOf = (base, i) => PIPE_PREFIX + (base + i);










function mpvIpc(pipeName, commands) {
    return new Promise((resolve) => {
        let settled = false;
        let exists = true; 
        let buf = '';
        const replies = {};

        const done = () => {
            if (settled) return; 
            settled = true;
            window.clearTimeout(timer);
            try {
                sock.destroy();
            } catch {
                
            }
            resolve({ exists, replies });
        };

        const sock = net.connect(pipePathOf(pipeName));

        



        sock.setEncoding('utf8');

        const timer = window.setTimeout(done, TIMING.ipcTimeout);

        sock.on('connect', () => {
            let out = '';
            commands.forEach((cmd, i) => {
                out += JSON.stringify({ command: cmd, request_id: i + 1 }) + '\n';
            });
            sock.write(out);
        });

        sock.on('data', (chunk) => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim()) continue;

                let msg;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue; 
                }
                
                if (typeof msg.request_id === 'number' && msg.request_id > 0) {
                    replies[msg.request_id] = msg;
                    if (Object.keys(replies).length === commands.length) return done();
                }
            }
        });

        sock.on('error', (err) => {
            if (err && err.code === 'ENOENT') exists = false; 
            done();
        });

        


        sock.on('close', done);
    });
}






const PROBE_COMMANDS = [
    ['get_property', 'filename'],
    ['get_property', 'path'],
    ['get_property', 'time-pos'],
    ['get_property', 'duration'],
];









async function probeSlot(pipeName) {
    const { exists, replies } = await mpvIpc(pipeName, PROBE_COMMANDS);
    const ok = (n) => (replies[n] && replies[n].error === 'success' ? replies[n].data : null);

    const file = ok(1);
    
    const p = ok(2);
    const secs = ok(3);
    const dur = ok(4);
    return {
        pipe: pipeName,
        now: file
            ? {
                  file,
                  path: typeof p === 'string' ? p : null,
                  seconds: typeof secs === 'number' ? secs : null,
                  duration: typeof dur === 'number' ? dur : null,
              }
            : null,
        free: !exists,
    };
}


async function mpvSeek(pipeName, seconds) {
    const { replies } = await mpvIpc(pipeName, [['set_property', 'time-pos', seconds]]);
    return !!(replies[1] && replies[1].error === 'success');
}






const probeRange = (base) =>
    Promise.all(
        Array.from({ length: IPC_SLOT_COUNT }, (_, i) => probeSlot(pipeNameOf(base, i)))
    );





const playingOn = (probed) =>
    probed.filter((p) => p.now).map((p) => ({ pipe: p.pipe, ...p.now }));










async function scanMpv(base, target, probed, isUsable) {
    const all = probed || (await probeRange(base));
    return {
        match: all.find((p) => p.now?.file === target)?.pipe || '',
        free: all.find((p) => p.free && (!isUsable || isUsable(p.pipe)))?.pipe || '',
    };
}













const PS_MPV_TITLES =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    'Get-Process -Name mpvnet -ErrorAction SilentlyContinue ' +
    '| ForEach-Object { $_.MainWindowTitle }';










function parseMpvTitle(out) {
    for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const m = t.match(/^(.*?) - mpv\.net$/);
        const name = m ? m[1].trim() : t;
        if (name && name !== 'mpv.net') return name;
    }
    return null;
}


function mpvWindowTitle() {
    return new Promise((resolve) => {
        if (!Platform.isWin) return resolve(null); 

        
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', PS_MPV_TITLES],
            { windowsHide: true }
        );
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.on('error', () => resolve(null));
        child.on('close', () => resolve(parseMpvTitle(out)));
    });
}





























function snapshotScaleFilter(mode) {
    const targetPx = SNAP_PX_TARGET[mode] ?? 0;
    if (!targetPx) return null; 
    return (
        `scale=w=iw*sqrt(2*${targetPx}/(${targetPx}+iw*ih+abs(${targetPx}-iw*ih))):h=-1`
    );
}





const SNAP_QUALITY_MIN = 20;










function clampQuality(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_SETTINGS.snapshotQuality;
    return Math.min(100, Math.max(SNAP_QUALITY_MIN, n));
}


function resolveSnapQuality(v) {
    return clampQuality(v);
}






async function readAt(fh, position, length) {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}


function secondsFrom(timescale, duration, unknownMark) {
    if (!(timescale > 0)) return null;
    if (!(duration > 0) || duration === unknownMark) return null;
    const sec = duration / timescale;
    return Number.isFinite(sec) && sec > 0 ? sec : null;
}


function mvhdDuration(buf) {
    const at = buf.indexOf('mvhd', 0, 'latin1');
    if (at < 0) return null;
    const p = at + 4; 
    if (buf[p] === 1) {
        
        if (p + 32 > buf.length) return null;
        const timescale = buf.readUInt32BE(p + 20);
        const duration = Number(buf.readBigUInt64BE(p + 24));
        return secondsFrom(timescale, duration, Number.MAX_SAFE_INTEGER);
    }
    
    if (p + 20 > buf.length) return null;
    return secondsFrom(buf.readUInt32BE(p + 12), buf.readUInt32BE(p + 16), 0xffffffff);
}






async function durationMp4(fh, size) {
    let pos = 0;
    for (let guard = 0; guard < 64 && pos + 8 <= size; guard++) {
        const head = await readAt(fh, pos, 8);
        if (head.length < 8) return null;
        let boxSize = head.readUInt32BE(0);
        const type = head.toString('latin1', 4, 8);
        let headerLen = 8;
        if (boxSize === 1) {
            const ext = await readAt(fh, pos + 8, 8);
            if (ext.length < 8) return null;
            boxSize = Number(ext.readBigUInt64BE(0));
            headerLen = 16;
        } else if (boxSize === 0) {
            boxSize = size - pos; 
        }
        if (!(boxSize >= headerLen) || pos + boxSize > size) return null;
        if (type === 'moov') {
            const body = await readAt(fh, pos + headerLen, Math.min(boxSize - headerLen, 64 * 1024));
            return mvhdDuration(body);
        }
        pos += boxSize;
    }
    return null;
}


function ebmlId(buf, p) {
    const first = buf[p];
    if (first === undefined) return null;
    for (let len = 1; len <= 4; len++) {
        if (first & (0x80 >> (len - 1))) {
            if (p + len > buf.length) return null;
            let id = 0;
            for (let i = 0; i < len; i++) id = id * 256 + buf[p + i];
            return { id, len };
        }
    }
    return null;
}

function ebmlSize(buf, p) {
    const first = buf[p];
    if (first === undefined) return null;
    for (let len = 1; len <= 8; len++) {
        if (first & (0x80 >> (len - 1))) {
            if (p + len > buf.length) return null;
            let size = first & (0xff >> len);
            let allOnes = size === (0xff >> len);
            for (let i = 1; i < len; i++) {
                size = size * 256 + buf[p + i];
                allOnes = allOnes && buf[p + i] === 0xff;
            }
            return { size: allOnes ? null : size, len }; 
        }
    }
    return null;
}






function ebmlDuration(buf) {
    let p = 0;
    let info = null;

    {   
        const id = ebmlId(buf, p);
        if (!id || id.id !== 0x1a45dfa3) return null;
        const sz = ebmlSize(buf, p + id.len);
        if (!sz || sz.size === null) return null;
        p += id.len + sz.len + sz.size;
    }
    for (let guard = 0; guard < 16 && p < buf.length; guard++) { 
        const id = ebmlId(buf, p);
        if (!id) break;
        const sz = ebmlSize(buf, p + id.len);
        if (!sz) break;
        if (id.id === 0x18538067) { 
            p += id.len + sz.len;
            

            const limit = sz.size === null ? buf.length : p + sz.size;
            for (let g2 = 0; g2 < 32 && p < limit; g2++) {
                const cid = ebmlId(buf, p);
                if (!cid) break;
                const csz = ebmlSize(buf, p + cid.len);
                if (!csz || csz.size === null) break;
                if (cid.id === 0x1549a966) { info = { at: p + cid.len + csz.len, size: csz.size }; break; }
                if (cid.id === 0x1f43b675) break; 
                p += cid.len + csz.len + csz.size;
            }
            break;
        }
        if (sz.size === null) break;
        p += id.len + sz.len + sz.size;
    }
    if (!info) return null;

    let timecodeScale = 1000000; 
    let duration = null;
    let q = info.at;
    const end = info.at + info.size;
    for (let guard = 0; guard < 32 && q < end && q < buf.length; guard++) {
        const id = ebmlId(buf, q);
        if (!id) break;
        const sz = ebmlSize(buf, q + id.len);
        if (!sz || sz.size === null) break;
        const body = q + id.len + sz.len;
        if (body + sz.size > buf.length) break;
        if (id.id === 0x2ad7b1) { 
            let v = 0;
            for (let i = 0; i < sz.size; i++) v = v * 256 + buf[body + i];
            if (v > 0) timecodeScale = v;
        } else if (id.id === 0x4489) { 
            if (sz.size === 4) duration = buf.readFloatBE(body);
            else if (sz.size === 8) duration = buf.readDoubleBE(body);
        }
        q = body + sz.size;
    }
    if (!(duration > 0)) return null;
    return (duration * timecodeScale) / 1e9;
}












async function durationFromFile(file) {
    let fh = null;
    try {
        const stat = await fs.promises.stat(file);
        if (!(stat.size > 8)) return null;
        fh = await fs.promises.open(file, 'r');
        const head = await readAt(fh, 0, 4);
        if (head.length < 4) return null;
        if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
            const buf = await readAt(fh, 0, Math.min(stat.size, 256 * 1024));
            return ebmlDuration(buf);
        }
        return await durationMp4(fh, stat.size);
    } catch {
        return null; 
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
}





function snapshotFileName(keyword, seconds, ext) {
    return `${snapShortName(keyword)}-${formatTime(seconds)}${ext}`.replace(SNAP_NAME_BAD, '-');
}






function cleanFolderPath(v) {
    const trimmed = String(v ?? '').trim();
    if (!trimmed) return '';
    return normalizePath(trimmed)
        .replace(/^(\.\.\/)+/, '')
        .replace(/^\/+|\/+$/g, '');
}









function normalizePathInput(v) {
    const trimmed = String(v ?? '').trim();
    return trimmed ? path.normalize(trimmed) : '';
}





const isCompleteJpeg = (b) =>
    b.length > 4 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;









async function removeDir(dir) {
    const attempts = 4; 
    for (let i = 0; i < attempts; i++) {
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
            return;
        } catch {
            if (i < attempts - 1) await sleep(150);
        }
    }
}


let snapSeq = 0;
const snapDirName = () => `s${Date.now().toString(36)}-${(snapSeq++).toString(36)}`;





let snapBusy = 0;






async function firstImageName(dir) {
    let names;
    try {
        names = await fs.promises.readdir(dir);
    } catch {
        return null; 
    }
    const imgs = names.filter((n) => SNAP_IMAGE_NAME.test(n));
    if (!imgs.length) return null;
    imgs.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    return imgs[0];
}






const cursorRange = (editor) => ({
    from: editor.posToOffset(editor.getCursor('from')),
    to: editor.posToOffset(editor.getCursor('to')),
});


const cursorOffset = (editor) => editor.posToOffset(editor.getCursor());





class MpvLinkerPlugin extends Plugin {
    


    pipeReservations = new Map();

    
    get mpvPath() {
        return this.settings.mpvPath || 'mpvnet';
    }

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new MpvLinkerSettingTab(this.app, this));

        

        void this.clearSnapDir();

        
        const plugin = this;

        







        this.registerEditorExtension(
            ViewPlugin.fromClass(
                class {
                    constructor(view) {
                        this.refresh(view); 
                    }

                    update(u) {
                        const was = u.startState.field(editorLivePreviewField, false);
                        const now = u.state.field(editorLivePreviewField, false);

                        if (u.docChanged || was !== now) {
                            this.refresh(u.view);
                        } else if (
                            u.selectionSet &&
                            (touchesAny(this.links, u.state.selection.main) ||
                                touchesAny(this.links, this.sel))
                        ) {
                            this.refresh(u.view);
                        }
                    }

                    refresh(view) {
                        const { state } = view;
                        this.links = scanLinks(state);
                        this.sel = state.selection.main;
                        this.decorations = state.field(editorLivePreviewField, false)
                            ? buildDecorations(this.links, this.sel, plugin)
                            : Decoration.none;
                    }
                },
                { decorations: (v) => v.decorations }
            )
        );

        
        this.registerMarkdownPostProcessor((el) => {
            if (el.textContent.includes('{@')) this.renderLinks(el);
        });

        








        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, info) =>
                this.buildEditorMenu(menu, editor, info)
            )
        );
        this.registerDomEvent(
            document,
            'contextmenu',
            (e) => {
                
                
                if (this.linkHint && !e.target.closest('.mpv-linker-link')) this.linkHint = null;
            },
            true
        );
    }

    

    
    renderLinks(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                
                return node.nodeValue.includes('{@') &&
                    !node.parentElement.closest(SKIP_SELECTOR)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            },
        });

        
        const nodes = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
        for (const node of nodes) this.replaceNode(node);
    }

    replaceNode(node) {
        const text = node.nodeValue;
        const re = createLinkRegex();
        let frag = null;
        let last = 0;
        let m;

        while ((m = re.exec(text)) !== null) {
            frag ||= document.createDocumentFragment();
            if (m.index > last) {
                frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            }
            const keyword = m[1];
            frag.appendChild(
                buildLinkDom(keyword, splitTimes(m[2]), (t, isKeywordClick) =>
                    this.playVideo(keyword, t, isKeywordClick)
                )
            );
            last = m.index + m[0].length;
        }

        
        if (!frag) return;
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }

    


    async mpvPathExists() {
        const mpvPath = this.mpvPath;
        return !/[\\/]/.test(mpvPath) || (await fileExists(mpvPath));
    }

    












    async resolveVideoFile(keyword, { missMessage, ambiguousTail, requireMpv = true }) {
        const dir = this.settings.videoDirectory;
        if (!dir) {
            notice('请先在设置里填写「视频文件目录」');
            return null;
        }

        

        const { dirOk, hits } = await this.findVideoFiles(dir, keyword);
        if (!dirOk) {
            notice(`视频目录不存在或无法读取 → ${dir}`);
            return null;
        }

        if (requireMpv && !(await this.mpvPathExists())) {
            notice(`找不到 mpv.net 可执行文件 → ${this.mpvPath}`);
            return null;
        }

        
        if (!hits.length) {
            notice(missMessage);
            return null;
        }
        if (hits.length > 1) {
            this.notifyAmbiguous(keyword, hits, ambiguousTail);
            return null;
        }
        return hits[0];
    }

    




    async playVideo(keyword, time, isKeywordClick = false) {
        const mpvPath = this.mpvPath;

        
        const fail = (msg) => void notice(msg);

        const file = await this.resolveVideoFile(keyword, {
            missMessage: `未找到文件名包含「${keyword}」的视频`,
        });
        if (!file) return;
        
        let seconds = parseTimeToSeconds(time);
        const base = this.settings.mpvIpcBase; 

        























        
        const probed = await this.probeAll();

        if (isKeywordClick) {
            const target = path.basename(file);
            const sameNamed = playingOn(probed).some((p) => p.file === target);
            if (sameNamed) {
                notice(ALREADY_PLAYING_MESSAGE);
                return;
            }
        }

        





        if (isKeywordClick) {
            time = '';
            seconds = null;
        }

        








        if (seconds !== null) {
            const duration = await this.durationOf(file, probed);
            if (duration !== null && seconds > duration) {
                return fail(DURATION_EXCEEDED_MESSAGE);
            }
        }

        let free = '';
        if (base > 0) {
            const r = await this.reuseWindow(base, file, seconds, time, probed);
            if (r.reused) {
                


                this.currentPipe = r.pipe;
                return;
            }
            free = r.free;
        }

        new Notice(`▶ ${path.basename(file)}${time ? ' @ ' + time : ''}`, PLAY_NOTICE_MS);
        

        this.reservePipe(free);
        const child = this.launchMpv(mpvPath, file, seconds, free);
        
        this.lastLaunch = { file, at: Date.now(), pipe: free, child };
        
        
        this.currentPipe = free;

        


        const forget = () => {
            if (this.lastLaunch && this.lastLaunch.child === child) this.lastLaunch = null;
            this.releasePipe(free); 
        };
        child.on('exit', forget);
        child.on('error', forget);
    }

    












    reservePipe(pipe) {
        if (!pipe) return;
        this.pipeReservations.set(pipe, Date.now());
    }

    releasePipe(pipe) {
        if (pipe) this.pipeReservations.delete(pipe);
    }

    
    isPipeReserved(pipe) {
        const at = this.pipeReservations.get(pipe);
        if (at === undefined) return false;
        if (Date.now() - at > TIMING.launchFreshMs) {
            this.pipeReservations.delete(pipe);
            return false;
        }
        return true;
    }

    
















    async reuseWindow(base, file, seconds, time, probed) {
        const target = path.basename(file);
        const launched =
            this.lastLaunch &&
            this.lastLaunch.file === file &&
            Date.now() - this.lastLaunch.at < TIMING.launchFreshMs
                ? this.lastLaunch
                : null;

        



        const reuseFoundPlaying = async (pipe) => {
            if (seconds !== null) {
                if (!(await mpvSeek(pipe, seconds))) return false;
                new Notice(`⏩ 已有窗口在播，跳到 ${time || '00:00'}`, PLAY_NOTICE_MS);
            } else {
                notice(ALREADY_PLAYING_MESSAGE);
            }
            return { reused: true, pipe, free: '' };
        };

        if (launched && launched.pipe) {
            const until = Date.now() + TIMING.launchRetryMs;
            do {
                if ((await probeSlot(launched.pipe)).now?.file === target) {
                    const r = await reuseFoundPlaying(launched.pipe);
                    if (r) return r;
                    break; 
                }
                
                if (this.lastLaunch !== launched) break;
                await sleep(TIMING.pollMs);
            } while (Date.now() < until);
        }

        const { match, free } = await scanMpv(base, target, probed, (pipe) => !this.isPipeReserved(pipe));
        if (match) {
            const r = await reuseFoundPlaying(match);
            if (r) return r;
        }
        return { reused: false, pipe: '', free };
    }

    








    notifyAmbiguous(keyword, hits, tail = '未播放') {
        const frag = document.createDocumentFragment();
        
        const line = (text, cls) => {
            const el = frag.appendChild(document.createElement('div'));
            if (cls) el.className = cls;
            el.textContent = text;
            return el;
        };

        line(`${NOTICE_PREFIX}「${keyword}」命中 ${hits.length} 个视频，${tail}`);
        const list = line('', 'mpv-linker-notice-list');
        
        for (const p of hits) list.appendChild(document.createElement('div')).textContent = path.basename(p);
        line('把链接里的关键词写得更精确，即可只命中其中一个', 'mpv-linker-notice-tip');

        new Notice(frag, 0);
    }

    













    launchMpv(mpvPath, videoPath, seconds, pipeName) {
        





















        const jumpArgs = seconds === null ? [] : [`--start=${seconds}`, '--no-resume-playback'];
        const args = [
            ...parseExtraArgs(this.settings.mpvExtraArgs),
            
            '--process-instance=multi',
            
            ...jumpArgs,
        ];

        
        if (pipeName) {
            args.push(`--input-ipc-server=${pipePathOf(pipeName)}`);
        }

        



        args.push('--', videoPath);

        










        const child = spawn(mpvPath, args, {
            windowsHide: false,
            detached: true,
            stdio: 'ignore',
        });

        child.on('error', () =>
            notice('启动 mpv.net 失败，请检查设置中的播放器路径')
        );
        child.unref();
        return child;
    }

    

    












    buildEditorMenu(menu, editor, info) {
        const hint = this.linkHint;
        


        const file = info?.file ?? null;
        menu.addItem((item) => {
            item.setTitle('MPV Linker').setIcon('play');
            
            const sub = item.setSubmenu?.() ?? menu;
            sub.addItem((i) =>
                i.setTitle('插入视频').setIcon(FILM_ICON).onClick(() => this.insertVideo(editor, hint))
            );
            sub.addItem((i) =>
                i.setTitle('插入时间节点')
                    .setIcon(CLOCK_ICON)
                    .onClick(() => this.insertTimeNode(editor, hint))
            );
            sub.addItem((i) =>
                i.setTitle('删除链接或时间节点')
                    .setIcon(SCISSORS_ICON)
                    .onClick(() => this.deleteLinkOrTime(editor, hint))
            );
            sub.addItem((i) =>
                i.setTitle('插入截图')
                    .setIcon(CAMERA_ICON)
                    .onClick(() => this.captureFrame(editor, hint, file))
            );
            sub.addItem((i) =>
                i.setTitle('在系统资源管理器中显示')
                    .setIcon(FOLDER_ICON)
                    .onClick(() => this.revealInExplorer(editor, hint))
            );
        });
    }

    




    rememberLink(from, to, timeIndex) {
        this.linkHint = { from, to, timeIndex };
    }

    






    async probeAll() {
        const base = this.settings.mpvIpcBase;
        return base > 0 ? probeRange(base) : [];
    }

    





    async playingWindows(probed) {
        return playingOn(probed || (await this.probeAll()));
    }

    










    async playingForKeyword(keyword) {
        const hit = (await this.playingWindows()).filter((p) => keywordOf(p.file).includes(keyword));
        if (!hit.length) return null;
        return hit.find((p) => p.pipe === this.currentPipe) || hit[0];
    }

    














    async currentPlayback() {
        

        const playing = await this.playingWindows();
        if (playing.length) {
            
            const recent = playing.find((p) => this.currentPipe && p.pipe === this.currentPipe);
            return recent || playing[0];
        }

        const titled = await mpvWindowTitle();
        return titled ? { pipe: '', file: titled, path: null, seconds: null } : null;
    }

    










    async unreadablePlaybackReason(noPlaybackMessage, titled = undefined) {
        if (this.settings.mpvIpcBase <= 0) return NO_IPC_MESSAGE;
        


        const t = titled === undefined ? await mpvWindowTitle() : titled;
        if (t) return WINDOW_NOT_CAPTURED_MESSAGE;
        return noPlaybackMessage;
    }

    
    async playingOrNotify() {
        const playing = await this.currentPlayback();
        if (playing) return playing;

        
        notice(await this.unreadablePlaybackReason(NO_MPV_MESSAGE, null));
        return null;
    }

    



    resolveTarget(editor, hint) {
        const links = scanTextLinks(editor.getValue());

        
        
        
        if (hint) {
            const at = links.find((l) => sameRange(l, hint));
            if (at) return { link: at, timeIndex: hint.timeIndex, fromHint: true };
        }

        
        const sel = cursorRange(editor);
        const link = links.find((l) => touches(l, sel));
        if (!link) return null;

        
        const ranges = timeRangesAt(link.from, link.keyword, link.times);
        return { link, timeIndex: timeIndexAt(ranges, sel), fromHint: false };
    }

    







    cursorInsideLink(editor, link) {
        const sel = cursorRange(editor);
        return link.from < sel.to && sel.from < link.to;
    }

    
    resolveLink(editor, hint) {
        const target = this.resolveTarget(editor, hint);
        return target ? target.link : null;
    }

    









    insertBlockedByLink(editor, hint) {
        const links = scanTextLinks(editor.getValue());
        if (hint && links.some((l) => sameRange(l, hint))) return true;
        const at = cursorOffset(editor);
        return links.some((l) => l.from < at && at < l.to);
    }

    








    async insertVideo(editor, hint) {
        if (this.insertBlockedByLink(editor, hint)) {
            return notice(LINK_EXISTS_MESSAGE);
        }

        const playing = await this.playingOrNotify();
        if (!playing) return;

        const name = keywordOf(playing.file);
        if (KEYWORD_BAD.test(name)) return this.notifyBadKeyword(playing.file);
        this.insertText(editor, `{@${name}}`);
    }

    




    async insertTimeNode(editor, hint) {
        const link = this.resolveLink(editor, hint);

        





        let playing = link ? await this.playingForKeyword(link.keyword) : null;
        if (!playing) playing = await this.playingOrNotify();
        if (!playing) return;

        
        if (playing.seconds === null) {
            return notice(WINDOW_NOT_CAPTURED_MESSAGE);
        }

        const name = keywordOf(playing.file);
        const time = formatTime(playing.seconds);

        if (link) {
            
            
            if (!name.includes(link.keyword)) {
                return notice('该链接与mpv.net正在播放的视频名称不匹配！');
            }
            if (link.times.includes(time)) {
                return notice(`这条链接里已经有「${time}」了`, PLAY_NOTICE_MS);
            }
            const text = linkTextWithTime(link, time); 
            this.replaceRange(editor, link.from, link.to, text);
            return;
        }

        if (KEYWORD_BAD.test(name)) return this.notifyBadKeyword(playing.file);
        this.insertText(editor, `{@${name}&${time}}`);
    }

    
    insertText(editor, text) {
        const at = cursorOffset(editor);
        this.replaceRange(editor, at, at, text);
    }

    






    replaceRange(editor, from, to, text) {
        editor.replaceRange(text, editor.offsetToPos(from), editor.offsetToPos(to));
        editor.setCursor(editor.offsetToPos(from + text.length));
    }

    















    deleteLinkOrTime(editor, hint) {
        
        const miss = () => notice(DELETE_HINT_MESSAGE);

        const target = this.resolveTarget(editor, hint);
        if (!target) return miss();
        
        if (!target.fromHint && !this.cursorInsideLink(editor, target.link)) return miss();

        const { link, timeIndex } = target;
        const text = timeIndex >= 0 ? linkTextWithoutTime(link, timeIndex) : ''; 

        




        editor.setCursor(editor.offsetToPos(link.to));
        this.replaceRange(editor, link.from, link.to, text);
    }

    
    notifyBadKeyword(file) {
        notice(
            '视频名里有 { } & | 之类的保留字符，没法写成链接 → ' +
                path.basename(file)
        );
    }

    






    async revealInExplorer(editor, hint) {
        const target = this.resolveTarget(editor, hint);
        if (!target) return notice('请在mpv.net视频链接上右键选择该命令！');

        
        const file = await this.resolveVideoFile(target.link.keyword, {
            missMessage: '指定目录下未匹配到相关视频！',
            ambiguousTail: '未打开文件夹',
            requireMpv: false,
        });
        if (!file) return;

        this.revealFile(file);
    }

    









    revealFile(file) {
        
        
        const win = Platform.isWin;
        const [cmd, args] = win
            ? ['explorer.exe', [`/select,"${file}"`]]
            : Platform.isMacOS
              ? ['open', ['-R', file]]
              : ['xdg-open', [path.dirname(file)]];

        const child = spawn(cmd, args, {
            windowsHide: false,
            detached: true,
            stdio: 'ignore',
            





            windowsVerbatimArguments: win,
        });
        
        child.on('error', () => notice('打开系统文件管理器失败'));
        child.unref();
    }

    

    












    async captureFrame(editor, hint, file = null) {
        const target = this.resolveTarget(editor, hint);

        
        if (target && target.timeIndex < 0) {
            const playing = await this.matchingPlaying(target.link.keyword);
            if (!playing) {
                







                const title = await mpvWindowTitle();
                if (title && title.includes(target.link.keyword)) {
                    return notice(WINDOW_NOT_CAPTURED_MESSAGE);
                }
                return notice(SNAP_TIME_ONLY_MESSAGE);
            }

            




            return this.captureVideo(editor, keywordOf(playing.file), playing.seconds, playing.path, false, {
                link: target.link,
                sourceFile: file,
            });
        }

        
        if (target) {
            const { link, timeIndex } = target;
            return this.captureVideo(
                editor,
                link.keyword,
                parseTimeToSeconds(link.times[timeIndex]),
                null,
                true,
                { link, sourceFile: file }
            );
        }

        
        const playing = await this.currentPlayback();
        if (!playing) {
            
            
            return notice(await this.unreadablePlaybackReason(SNAP_NO_PLAYING_MESSAGE, null));
        }
        
        if (!playing.pipe || playing.seconds === null || !playing.path) {
            return notice(WINDOW_NOT_CAPTURED_MESSAGE);
        }

        
        return this.captureVideo(editor, keywordOf(playing.path), playing.seconds, playing.path, false, {
            sourceFile: file,
        });
    }

    











    async matchingPlaying(keyword) {
        const playing = await this.playingForKeyword(keyword);
        if (!playing || playing.seconds === null || !playing.path) return null;
        return { file: playing.file, seconds: playing.seconds, path: playing.path };
    }

    













    async durationOf(file, probed) {
        const target = path.basename(file);
        for (const p of await this.playingWindows(probed)) {
            if (p.file === target && typeof p.duration === 'number' && p.duration > 0) {
                return p.duration;
            }
        }
        return durationFromFile(file);
    }

    











    async captureVideo(
        editor,
        keyword,
        seconds,
        videoPath,
        checkRange = false,
        { link = null, sourceFile = null } = {}
    ) {
        let video = videoPath;
        if (!video) {
            video = await this.resolveVideoFile(keyword, {
                missMessage: `未找到文件名包含「${keyword}」的视频`,
                ambiguousTail: '未截图',
            });
            if (!video) return;
        } else if (!(await this.mpvPathExists())) {
            

            return notice(`找不到 mpv.net 可执行文件 → ${this.mpvPath}`);
        }

        

        if (checkRange && seconds !== null) {
            const duration = await this.durationOf(video);
            if (duration !== null && seconds > duration) {
                return notice(DURATION_EXCEEDED_MESSAGE);
            }
        }

        try {
            const shot = await this.captureFrameAt(video, seconds);
            if (!shot) return notice(SNAP_NO_IMAGE_MESSAGE);

            const markdown = await this.writeSnapshot(shot.bytes, keyword, seconds, sourceFile);
            if (!markdown) return; 

            


            this.insertSnapshotLink(editor, markdown, link);
        } catch (err) {
            




            console.error('[MPV Linker] 截图写盘失败：', err);
            notice(SNAP_SAVE_FAILED_MESSAGE);
        } finally {
            


            await this.clearSnapDir();
        }
    }

    







    async captureFrameAt(videoPath, seconds) {
        const mpvPath = this.mpvPath;
        const dir = path.join(SNAP_ROOT, snapDirName());
        snapBusy++;

        try {
            await fs.promises.mkdir(dir, { recursive: true });
            const filter = snapshotScaleFilter(this.settings.snapshotResolution);
            return await this.runImageOutput(mpvPath, videoPath, seconds, dir, filter);
        } finally {
            await removeDir(dir);
            snapBusy--;
        }
    }

    



























    async runImageOutput(mpvPath, videoPath, seconds, dir, filter) {
        const args = [
            





            '--process-instance=multi',
            





            `--vo-image-outdir=${dir}`,
            `--vo-image-format=${SNAP_FORMAT}`,
            `--vo-image-jpeg-quality=${resolveSnapQuality(this.settings.snapshotQuality)}`,
            '--vo=image',
            ...(filter ? [`--vf=${filter}`] : []),
            `--start=${seconds}`,
            












            '--no-resume-playback',
            '--frames=1',
            '--no-audio',
            '--no-config',
            '--window-minimized=yes',
        ];

        
        
        args.push('--', videoPath);

        







        const child = spawn(mpvPath, args, { windowsHide: true, stdio: 'ignore', cwd: dir });

        let spawnFailed = false;
        child.on('error', () => (spawnFailed = true));

        await new Promise((resolve) => {
            let settled = false;
            let timer = null;
            let poll = null;
            let lastSize = -1;
            let stableSince = 0;

            

            const finish = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                window.clearInterval(poll);
                resolve();
            };
            const stop = () => {
                try {
                    child.kill();
                } catch {
                    
                }
                finish();
            };

            

            timer = window.setTimeout(stop, TIMING.snapTimeoutMs);

            const check = async () => {
                if (settled) return;
                const name = await firstImageName(dir);
                if (!name) return;

                let size;
                try {
                    size = (await fs.promises.stat(path.join(dir, name))).size;
                } catch {
                    return; 
                }
                
                if (size !== lastSize) {
                    lastSize = size;
                    stableSince = Date.now();
                    return;
                }
                if (Date.now() - stableSince < TIMING.snapStableMs) return;

                
                const bytes = await fs.promises.readFile(path.join(dir, name)).catch(() => null);
                if (bytes && isCompleteJpeg(bytes)) stop();
            };

            poll = window.setInterval(() => void check(), TIMING.snapPollMs);
            child.on('error', finish);
        });

        if (spawnFailed) return null;

        


        await waitForExit(child, TIMING.snapExitGraceMs);
        return this.readFirstFrame(dir);
    }

    



    async readFirstFrame(dir) {
        const name = await firstImageName(dir);
        if (!name) return null;

        try {
            const bytes = await fs.promises.readFile(path.join(dir, name));
            



            if (!isCompleteJpeg(bytes)) return null;
            return { bytes };
        } catch {
            return null;
        }
    }

    


















    async writeSnapshot(bytes, keyword, seconds, sourceFile = null) {
        const fm = this.app.fileManager;
        const note = sourceFile || this.app.workspace.getActiveFile();
        const sourcePath = note ? note.path : '';
        const name = snapshotFileName(keyword, seconds, '.' + SNAP_FORMAT);

        const folder = this.settings.snapshotFolder;
        let dest;
        if (folder) {
            
            if (!(this.app.vault.getAbstractFileByPath(normalizePath(folder)) instanceof TFolder)) {
                notice(`${SNAP_FOLDER_MISSING_MESSAGE} → ${folder}`);
                

                return null;
            }
            dest = this.availablePathIn(folder, name);
        } else {
            dest = await fm.getAvailablePathForAttachment(name, sourcePath);
        }

        const file = await this.app.vault.createBinary(dest, bytes);
        return `!${fm.generateMarkdownLink(file, sourcePath)}`;
    }

    
    availablePathIn(folder, name) {
        const dot = name.lastIndexOf('.');
        const stem = name.slice(0, dot);
        const ext = name.slice(dot);
        for (let i = 0; i < 1000; i++) {
            const candidate = normalizePath(`${folder}/${i ? `${stem} ${i}` : stem}${ext}`);
            if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
        }
        return normalizePath(`${folder}/${stem} ${Date.now()}${ext}`);
    }

    










    insertSnapshotLink(editor, markdown, link) {
        if (link) {
            
            const line = editor.offsetToPos(link.to).line;
            const end = editor.posToOffset({ line, ch: editor.getLine(line).length });
            this.replaceRange(editor, end, end, '\n' + markdown);
            return;
        }

        const at = cursorOffset(editor);
        const inside = scanTextLinks(editor.getValue()).find((l) => l.from < at && at < l.to);
        const target = inside ? inside.to : at;
        this.replaceRange(editor, target, target, markdown);
    }

    
    async clearSnapDir() {
        if (snapBusy > 0) return;
        await removeDir(SNAP_ROOT);
    }

    

    










    async findVideoFiles(dir, keyword) {
        
        const exts = new Set(this.settings.videoExtensions);
        const hits = [];
        const stack = [dir];
        let rootOk = false;

        while (stack.length) {
            const current = stack.pop();
            let entries;
            try {
                entries = await fs.promises.readdir(current, { withFileTypes: true });
            } catch {
                continue; 
            }
            if (current === dir) rootOk = true;

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    stack.push(path.join(current, entry.name));
                    continue;
                }
                const dot = entry.name.lastIndexOf('.');
                if (dot < 0) continue;
                if (!exts.has(entry.name.slice(dot).toLowerCase())) continue;
                if (entry.name.slice(0, dot).includes(keyword)) {
                    





                    hits.push(path.join(current, entry.name));
                }
            }
        }

        
        if (hits.length > 1) hits.sort();
        return { dirOk: rootOk, hits };
    }

    

    async loadSettings() {
        const s = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        

        for (const key of ['videoDirectory', 'mpvPath', 'mpvExtraArgs', 'snapshotFolder']) {
            s[key] = String(s[key] ?? '');
        }
        








        for (const key of ['videoDirectory', 'mpvPath']) {
            s[key] = normalizePathInput(s[key]);
        }
        s.videoExtensions = Array.isArray(s.videoExtensions)
            ? normalizeExtensions(s.videoExtensions)
            : [...DEFAULT_SETTINGS.videoExtensions];
        const base = Math.floor(Number(s.mpvIpcBase));
        s.mpvIpcBase = base > 0 ? base : 0;

        
        if (!Object.prototype.hasOwnProperty.call(SNAP_PX_TARGET, s.snapshotResolution)) {
            s.snapshotResolution = DEFAULT_SETTINGS.snapshotResolution;
        }
        
        s.snapshotFolder = cleanFolderPath(s.snapshotFolder);

        
        s.snapshotQuality = clampQuality(s.snapshotQuality);

        this.settings = s;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}













function attachFolderSuggest(appRef, inputEl, onPick) {
    
    if (typeof AbstractInputSuggest !== 'function') return;

    return new (class extends AbstractInputSuggest {
        getSuggestions(query) {
            const q = query.trim().toLowerCase();
            return appRef.vault
                .getAllLoadedFiles()
                .filter(
                    (f) =>
                        f instanceof TFolder &&
                        f.path !== '/' &&
                        (!q || f.path.toLowerCase().includes(q))
                )
                .map((f) => f.path)
                .sort()
                .slice(0, 50);
        }

        renderSuggestion(path, el) {
            el.setText(path);
        }

        selectSuggestion(path) {
            onPick(path);
            this.close();
        }
    })(appRef, inputEl);
}

class MpvLinkerSettingTab extends PluginSettingTab {
    display() {
        const { containerEl } = this;
        const settings = this.plugin.settings;
        containerEl.empty();

        

        

        const field = (parent, name, desc, placeholder, value, save, normalize = null) =>
            new Setting(parent)
                .setName(name)
                .setDesc(desc)
                .addText((text) => {
                    text.setPlaceholder(placeholder)
                        .setValue(value)
                        .onChange(async (v) => {
                            save(v);
                            await this.plugin.saveSettings();
                        });
                    if (normalize) {
                        text.inputEl.addEventListener('blur', async () => {
                            const fixed = normalize(text.inputEl.value);
                            if (fixed !== text.inputEl.value) text.setValue(fixed);
                            save(fixed);
                            await this.plugin.saveSettings();
                        });
                    }
                    return text;
                });

        
        const dropdown = (parent, name, desc, options, value, save) =>
            new Setting(parent)
                .setName(name)
                .setDesc(desc)
                .addDropdown((dd) =>
                    dd.addOptions(options)
                        .setValue(value)
                        .onChange(async (v) => {
                            save(v);
                            await this.plugin.saveSettings();
                        })
                );

        field(
            containerEl,
            '视频文件目录',
            '视频放在哪个文件夹。填绝对路径，它下面的子文件夹会自动一起搜索。',
            '例如：D:\\Videos\\Trading',
            settings.videoDirectory,
            (v) => (settings.videoDirectory = v.trim()),
            normalizePathInput 
        );

        field(
            containerEl,
            'mpv.net 播放器路径',
            '播放器在哪。默认值能用就别改；便携版填 mpvnet.exe 的完整路径。',
            'mpvnet',
            settings.mpvPath,
            (v) => (settings.mpvPath = v.trim()),
            normalizePathInput 
        );

        field(
            containerEl,
            '视频扩展名',
            '哪些文件算视频。逗号分隔，一般不用改。',
            '.mp4,.mkv,.avi',
            settings.videoExtensions.join(','),
            (v) => (settings.videoExtensions = normalizeExtensions(v.split(',')))
        );

        new Setting(containerEl).setName('插入视频截图').setHeading();

        dropdown(
            containerEl,
            '截图分辨率＞2K时缩放操作(2560x1440)',
            '视频太大时先缩小再截图，省地方。本来就小的视频保持原样，绝不会被放大。',
            SNAP_RESOLUTION_OPTIONS,
            settings.snapshotResolution,
            (v) => (settings.snapshotResolution = v)
        );

        





        const qualitySetting = new Setting(containerEl)
            .setName('截图质量')
            .setDesc(
                `20~100，数值越大越清晰、图片也越大。默认 ${DEFAULT_SETTINGS.snapshotQuality}，` +
                    '右侧按钮可一键恢复。'
            );

        
        let qualitySlider = null;
        qualitySetting.addSlider((slider) => {
            qualitySlider = slider;
            slider
                .setLimits(SNAP_QUALITY_MIN, 100, 1)
                .setValue(clampQuality(settings.snapshotQuality))
                .setDynamicTooltip()
                .onChange(async (v) => {
                    settings.snapshotQuality = clampQuality(v);
                    await this.plugin.saveSettings();
                });
        });
        qualitySetting.addExtraButton((btn) =>
            btn
                .setIcon('rotate-ccw')
                .setTooltip(`重置为默认值 ${DEFAULT_SETTINGS.snapshotQuality}`)
                .onClick(async () => {
                    settings.snapshotQuality = DEFAULT_SETTINGS.snapshotQuality;
                    await this.plugin.saveSettings();
                    qualitySlider?.setValue(DEFAULT_SETTINGS.snapshotQuality);
                })
        );

        

        new Setting(containerEl)
            .setName('截图保存目录位置')
            .setDesc(
                '截图存到哪。留空 = 存到 Obsidian 的附件目录；也可以填仓库里已有的文件夹' +
                    '（边打字边有提示）。'
            )
            .addText((text) => {
                text.setPlaceholder('留空 = 附件默认位置')
                    .setValue(settings.snapshotFolder)
                    .onChange(async (v) => {
                        settings.snapshotFolder = cleanFolderPath(v);
                        await this.plugin.saveSettings();
                    });
                attachFolderSuggest(this.app, text.inputEl, (folder) => {
                    text.setValue(folder);
                    settings.snapshotFolder = cleanFolderPath(folder);
                    void this.plugin.saveSettings();
                });
            });

        new Setting(containerEl).setName('语法说明').setHeading();
        const ul = containerEl.createEl('ul');
        ul.createEl('li', { text: '{@关键词} → 播放文件名包含「关键词」的视频，从头播' });
        ul.createEl('li', { text: '{@关键词&03:28} → 跳到 03:28 播放' });
        ul.createEl('li', {
            text: '{@关键词&03:28|05:10|12:32} → 三个时间各自是可点的小链接，点哪个跳哪个',
        });
        ul.createEl('li', { text: '时间格式支持 mm:ss 与 hh:mm:ss' });
        ul.createEl('li', {
            text: '光标停在链接内部或紧贴两端边界时，保留 {@...} 原文，方便直接编辑',
        });

        


        const advanced = containerEl.createEl('details', { cls: 'mpv-linker-advanced' });
        advanced.createEl('summary', { text: '高级选项（一般不用动）' });

        field(
            advanced,
            'mpv.net 附加启动参数',
            '给播放器加的额外开关，空格分隔。一般留空；想让播放窗口一直浮在最上层就填 --ontop。',
            '留空',
            settings.mpvExtraArgs,
            (v) => (settings.mpvExtraArgs = v.trim())
        );

        field(
            advanced,
            '复用窗口通道',
            '同一个视频已经在播时，直接跳到时间点、不再开新窗口。填 0 就关掉这个功能。',
            '18730',
            String(settings.mpvIpcBase),
            (v) => (settings.mpvIpcBase = Math.max(0, parseInt(v, 10) || 0))
        );
    }
}





module.exports = MpvLinkerPlugin;


module.exports.__internals = {
    DEFAULT_SETTINGS,
    TIMING,
    IPC_SLOT_COUNT,
    PIPE_PREFIX,
    INPIPE_ROOT,
    NO_MPV_MESSAGE,
    WINDOW_NOT_CAPTURED_MESSAGE,
    NO_IPC_MESSAGE,
    LINK_EXISTS_MESSAGE,
    ALREADY_PLAYING_MESSAGE,
    DELETE_HINT_MESSAGE,
    FILM_ICON,
    CLOCK_ICON,
    SCISSORS_ICON,
    CAMERA_ICON,
    FOLDER_ICON,
    SNAP_ROOT,
    SNAP_QUALITY_MIN,
    resolveSnapQuality,
    clampQuality,
    durationFromFile,
    DURATION_EXCEEDED_MESSAGE,
    SNAP_IMAGE_NAME,
    SNAP_PX_1K,
    SNAP_PX_2K,
    SNAP_PX_TARGET,
    SNAP_TIME_ONLY_MESSAGE,
    SNAP_NO_PLAYING_MESSAGE,
    SNAP_NO_IMAGE_MESSAGE,
    SNAP_SAVE_FAILED_MESSAGE,
    SNAP_FOLDER_MISSING_MESSAGE,
    SNAP_NAME_MAX,
    createLinkRegex,
    parseTimeToSeconds,
    formatTime,
    keywordOf,
    buildTooltip,
    normalizeExtensions,
    parseExtraArgs,
    pipePathOf,
    pipeNameOf,
    mpvIpc,
    probeSlot,
    probeRange,
    playingOn,
    scanMpv,
    mpvSeek,
    parseMpvTitle,
    snapshotScaleFilter,
    snapshotFileName,
    isCompleteJpeg,
    firstImageName,
    cleanFolderPath,
    normalizePathInput,
    scanTextLinks,
    timeRangesAt,
    timeIndexAt,
    linkTextWithoutTime,
    linkTextWithTime,
    buildLinkDom,
    findBlocked,
};
