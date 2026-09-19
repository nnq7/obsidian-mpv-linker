'use strict';

/* ==================================================================
 *  mpv-linker · main.js
 *
 *  笔记里写 {@关键词}、{@关键词&03:28} 或 {@关键词&03:28|05:10|12:32}：
 *  在「视频文件目录」下递归找文件名包含关键词的视频，交给本地 mpv.net 播放；
 *  多个时间点时，每个时间都是独立可点的小链接。
 *
 *    实时预览 —— CodeMirror 6  ViewPlugin + Decoration.replace
 *    阅读模式 —— registerMarkdownPostProcessor 改写文本节点
 *    源码模式 —— 始终保留 {@...} 原文
 *
 *  复用窗口：mpv.net 用 `--input-ipc-server=\\.\pipe\<名字>` 在本机开一条**命名管道**，
 *  管道上跑的是 mpv 的 JSON IPC 行协议。点击前先问一句「你现在播的是不是这个视频」，
 *  是就直接 seek，不再开新窗口。
 *
 *  右键菜单：编辑器里右键 →「MPV Linker」→「插入视频」/「插入时间节点」
 *  /「删除链接或时间节点」/「插入截图」/「在系统资源管理器中显示」
 *  （顺序与图标见 FILM_ICON 那一组常量；沿用 VLC 版的用户指定次序，改之前先问）。
 *
 *  插入截图：起一个**独立的 mpv.net 进程**，用 mpv 自带的 image 视频输出
 *  （`--vo=image`）把目标秒的那一帧写成 jpg，写完就把它收掉。
 *  全程不碰用户正在看的任何窗口。
 *
 *  ⚠️ 与 VLC 版相比的两条硬约束（都是真机实测出来的，别凭推理改）：
 *    1. `--vo-image-outdir` **必须排在 `--vo=image` 之前**。顺序反了 mpv.net 会**静默忽略**
 *       输出目录，图被写到**进程的工作目录**里去 —— 不报错、不出提示，看着像「截图失败」。
 *       保险起见截图进程的 cwd 也设成同一个目录，两头堵。
 *    2. `--frames=1` **不可靠**（它不是 property 开关）。同一个目录里实测出现过
 *       00000001.jpg 与 00000002.jpg 两张 —— 所以**只认编号最小的那一张**（定位帧）。
 *    3. mpv.net **没有真正的无头模式**（官方手册：「A window free mode is currently not
 *       supported, the main window is always visible」），截图时必然出现一个窗口。
 *       只能加 `--window-minimized=yes` 让它别跳出来打扰人。
 *
 *  性能要点（本机实测：管道往返 0~10ms、spawn→管道就绪 ≈ 650ms、截图出图 ≈ 750ms）：
 *    · 点击路径上不做同步 IO —— 同步 IO 跑在渲染进程里会冻住 Obsidian 的界面；
 *    · 复用探测先只问「我们自己启动的那条管道」，问不到才整轮扫（见 reuseWindow）；
 *    · 「等刚启动的窗口把管道建起来」的重试，必须能被「窗口已被关掉」打断 ——
 *      否则用户每次关掉窗口再点同一链接，都要白等一整轮重试；
 *    · 通道区间永远**并行**探：万一有个「接了连接却不回应」的实例，串行会把
 *      N × ipcTimeout 全等一遍，点击后界面就一直没反应。
 *
 *  免构建：单文件 CommonJS，依赖全部由 Obsidian 运行时提供。
 * ================================================================== */

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

/*
 * @codemirror/* 由 Obsidian 运行时给到同一份实例，裸 require 即可
 * （dataview、strange-new-worlds 等插件都这么用）：无需构建，也只加载一次。
 */
const { ViewPlugin, Decoration, WidgetType } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');

/* ------------------------------------------------------------------ *
 *  常量
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
    videoDirectory: '',
    mpvPath: 'mpvnet',
    videoExtensions: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm'],
    /*
     * 附加启动参数，默认留空。留这个框是因为它有用：例如 --ontop 能让窗口一直压在最上面
     * （复用窗口时只能跳时间、没法把窗口带到前台）。
     * 别拿它去绕「窗口只在后台出声」——那个问题的真凶是 spawn 的 windowsHide，
     * 与这里无关（见 launchMpv）。
     */
    mpvExtraArgs: '',
    /*
     * 复用窗口用：mpv.net 的 IPC 通道占这个编号及其后共 8 个（拼成命名管道名）。
     * 0 = 关闭该功能。
     */
    mpvIpcBase: 18730,
    /*
     * 截图分辨率。源宽不到 3K(3000) 时根本用不到它（见 snapshotTargetWidth），
     * 取值 'none'（按原始分辨率）| '2k'（宽 2560）| '1k'（宽 1920）。
     */
    snapshotResolution: 'none',
    /*
     * 截图保存目录，**仓库内的相对路径**，留空 = 用 Obsidian 的附件默认位置。
     * 只收仓库内的目录：仓库外的图片插进笔记是显示不出来的（Obsidian 给不出可预览的链接）。
     */
    snapshotFolder: '',
};

const PLAY_NOTICE_MS = 3000;

/*
 * 「复用窗口通道」：每个 mpv.net 窗口占一条命名管道 —— 单条会被第一个实例长期占住，
 * 后续窗口就都不可控了。实际取该设置值起连续 IPC_SLOT_COUNT 个。
 *
 * 命名管道与 VLC 的端口有一点不同：管道是**进程私有**的，进程一死名字立刻释放，
 * 没有「TIME_WAIT」那种残留；所以「空闲」的判据很干净 —— 连接报 ENOENT 就是没人占。
 */
const IPC_SLOT_COUNT = 8;
const INPIPE_ROOT = '\\\\.\\pipe\\';
const PIPE_PREFIX = 'mpv-linker-';

/* 右键菜单读不到播放状态时的统一提示（mpv.net 没开、或窗口里没在播、或没带 IPC 通道） */
const NO_MPV_MESSAGE = '未获取到mpv.net视频，请检查mpv.net是否有视频正在播放！';

/*
 * 只认得文件名、认不出窗口时（能读到窗口标题，但那个窗口不是插件打开的）：
 * 通道里没有它，退路也给不出进度 —— 两条右键功能都用不了，如实说清是哪种情况。
 */
const WINDOW_NOT_CAPTURED_MESSAGE = '窗口获取失败！只有通过笔记链接打开的mpv.net视频窗口才能被捕获！';

/* 「复用窗口通道」填 0 = 关掉 IPC，这一项功能整体不可用 —— 提示要指到设置项，别只说读不到 */
const NO_IPC_MESSAGE = '插入需要 mpv.net 的远程接口，请把「复用窗口通道」设为非 0';

/* 位置已经是一条 {@...} 时，「插入视频」不插 —— 插到别处或嵌进原链接里都不是用户要的 */
const LINK_EXISTS_MESSAGE = '无法插入，当前位置已存在视频链接！';

/*
 * {@关键词} 里写不进这些字符：} 会提前收尾，& 和 | 是分隔符，换行更不用说。
 * 视频文件名恰好带上它们时，只能提示用户，不能硬插一条语法坏掉的链接。
 */
const KEYWORD_BAD = /[{}&|\n]/;

/*
 * 阅读模式：这些容器里的 {@...} 不接管 —— 代码块 <pre>、行内代码 <code>、链接自身。
 * 注释不用管：Obsidian 的 %%…%% 只在编辑视图可见，阅读视图根本不渲染它。
 * （实时预览没有现成的 DOM 结构可用，那里的代码/注释靠正则 + 状态机判定，见 findBlocked。）
 */
const SKIP_SELECTOR = 'pre, code, a';

/**
 * 时序参数。自测会把它们调小，好把「刚启动、通道还没就绪」的重试路径也测到。
 *
 * 全部数字都是本机 mpv.net-DW v2.1.0 真机实测的（VLC 版的数字一个都不能照抄）：
 *   ipcTimeout   —— 热管道一问一答 0~10ms，冷管道首次 60~94ms。
 *                   700ms 已是数十倍余量；而万一撞上「接了连接却不回应」的通道，
 *                   这一项直接决定用户干等多久（8 路是并行的，所以实际就等这一个超时）。
 *   launchRetryMs —— **实测 spawn→管道可连接 ≈ 650ms**（VLC 只要 214ms）。
 *                   1.5 s 是两倍余量；这只是兜底 —— 窗口被关掉时由子进程的 exit 事件立刻结束等待。
 *   snapTimeoutMs —— 实测出图 ≈ 750ms、图片完整可读 ≈ 1s，15 s 是十几倍余量。
 *                   这一项还兼作**保险丝**：mpv.net 遇到不认识的开关可能弹模态框等人点「确定」，
 *                   那就永远不退出 —— 没有超时就真的挂死了。
 *   snapExitGraceMs —— 收掉截图进程之后，最多再等它多久**真正**退出。
 *                   实测它基本是瞬间的；给 2 s 只是为了让「删临时目录」拿到干净的句柄
 *                   （kill 只是发信号，句柄没放开时 removeDir 会被 Windows 拒掉）。
 */
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

/* ------------------------------------------------------------------ *
 *  插入截图
 *
 *  走 mpv 自带的 image 视频输出（`--vo=image`）：一次进程只干一件事 ——
 *  跳到目标秒、把帧写成图片、自己退出。
 *
 *  ⚠️ 参数顺序是承重的：`--vo-image-outdir` 必须排在 `--vo=image` **之前**。
 *  顺序反了 mpv.net 会静默忽略输出目录，把图写进进程的工作目录（实测过，见 runImageOutput）。
 *
 *  为什么不是别的做法：
 *    · 抓屏 —— 本机 Add-Type / csc 被安全策略拦掉，写不了 P/Invoke；就算能调，
 *      窗口被别的窗口盖住就废、还带播放器边框、多显示器还要算 DPI；
 *    · 让正在播的那个窗口发 `screenshot-to-file` 命令 —— 用户明确要求
 *      「不要影响正在观看的视频」，而且那要求窗口是本插件启动的；
 *    · 复用/指挥用户正在看的那个窗口 —— 同上。
 *  改成独立进程之后，上面这些约束全部消失：不碰任何已有窗口。
 * ------------------------------------------------------------------ */

/**
 * 截图临时目录。**必须放系统临时目录、不能放仓库里**：
 * mpv.net 只往里写、插件读完就清，放进仓库 Obsidian 会把它当附件索引，同步盘还会逐张上传。
 * 另外这个目录**必须已经存在** —— 落盘前一律 mkdir。
 * 每截一张用一个唯一子目录，收尾整棵删掉（见 captureFrameAt）。
 */
const SNAP_ROOT = path.join(os.tmpdir(), 'mpv-linker-snap');

/** 截图格式：用户要求 jpg */
const SNAP_FORMAT = 'jpg';

/**
 * 画质参数是 `--vo-image-jpeg-quality`（不是 `--sout-jpeg-quality` —— 那是 VLC 的叫法）。
 * 用户要求质量 90。
 */
const SNAP_QUALITY = 90;

/**
 * 只认编号最小的那一张图（定位帧）。
 * ⚠️ `--frames=1` 不是 property 开关，mpv.net 不保证照做 —— 实测同一目录里出现过
 * 00000001.jpg 与 00000002.jpg 两张，多出来的会抖动，只有第一张是定位帧。
 */
const SNAP_IMAGE_NAME = /^\d+\.(?:jpg|jpeg|png|webp)$/i;

/** 3K 门槛宽度：源宽到了它，「截图分辨率」那个设置项才开始起作用 */
const SNAP_3K_WIDTH = 3000;
/** 下拉取值 → 目标宽度（0 = 不缩放，按原始分辨率） */
const SNAP_WIDTHS = { none: 0, '2k': 2560, '1k': 1920 };
/** 下拉选项文案，设置面板与 README 共用一份口径 */
const SNAP_RESOLUTION_OPTIONS = {
    none: '不操作，按原始分辨率截图',
    '2k': '缩放到2k(宽2560)',
    '1k': '缩放到1k(宽1920)',
};

/** 关键词超过这个长度就在文件名里截断，免得名字长得没法看 */
const SNAP_NAME_MAX = 24;
/* 按**码位**截断，不是 String.prototype.slice 的码元：后者会把 emoji 的代理对劈成半个，
   剩下那个孤立代理项写进文件名是非法字符（Windows 上直接建不出文件）。
   关键词里出现 emoji 不算罕见（视频名常带 🎞📈），所以这里多花一次展开数组的钱。 */
const snapShortName = (keyword) => [...keyword].slice(0, SNAP_NAME_MAX).join('');
/** 文件名里不能出现的字符（顺带把 mm:ss 的冒号也换掉） */
const SNAP_NAME_BAD = /[\\/:*?"<>|]/g;

/* 右键菜单子项的图标（Lucide 名，Obsidian 内置那套）。改名字前先在菜单里看一眼真图标 */
const FILM_ICON = 'film';
const CLOCK_ICON = 'clock';
const SCISSORS_ICON = 'scissors';
const CAMERA_ICON = 'camera';
const FOLDER_ICON = 'folder-open';

/* 提示语。前两条是用户指定的原话，别改口径。 */
const SNAP_TIME_ONLY_MESSAGE = '请在时间节点上操作！';
const SNAP_NO_PLAYING_MESSAGE = '截图失败，请检查mpv.net是否有视频正在播放';
/** 图片没落盘（时间点超出片长，或 mpv.net 压根没写出帧） */
const SNAP_NO_IMAGE_MESSAGE = '截图失败：mpv.net 没有写出图片';
/** 自定义保存目录不在仓库里 / 不存在 */
const SNAP_FOLDER_MISSING_MESSAGE = '截图保存目录不存在';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 路径存在吗。异步版 —— 同步的 existsSync / accessSync 会把渲染线程占住 */
const fileExists = (p) => fs.promises.access(p).then(() => true, () => false);

/**
 * 等子进程**真的**退出（最多等 ms 毫秒）。
 *
 * `child.kill()` 只是「发出终止请求」，Windows 上从发信号到句柄全部释放还有一小段时间 ——
 * 这期间它攥着刚写好的图片不撒手，删目录会被拒（EBUSY / EPERM），
 * 截图临时目录就留在盘上了（真机实测出现过一次空目录残留）。
 * exit / close / error 都可能先到，只认第一个；超时也放行，绝不把截图流程卡住。
 */
function waitForExit(child, ms) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode != null) return resolve();

        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(done, ms);
        child.once('exit', done);
        child.once('close', done);
        child.once('error', done);
    });
}

/* ------------------------------------------------------------------ *
 *  纯函数
 * ------------------------------------------------------------------ */

/** {@关键词} / {@关键词&mm:ss} / {@关键词&mm:ss|hh:mm:ss|...}
 *  每次新建实例：全局正则的 lastIndex 有状态，跨扫描复用会漏匹配。 */
const createLinkRegex = () =>
    /\{@([^}&\n|]+?)(?:&((?:\d{1,2}:\d{2}(?::\d{2})?)(?:\|\d{1,2}:\d{2}(?::\d{2})?)*))?\}/g;

/** "03:22|04:33" → ['03:22', '04:33']；空 → [] */
const splitTimes = (t) => (t ? t.split('|') : []);

/** "mm:ss" / "hh:mm:ss" → 秒。左到右累乘 60，非法段按 0 计。 */
function parseTimeToSeconds(t) {
    let s = 0;
    if (t) for (const n of t.split(':')) s = s * 60 + (Number(n) || 0);
    return s;
}

const buildTooltip = (k, times) =>
    times.length ? `mpv.net 播放：${k} @ ${times.join(' / ')}` : `mpv.net 播放：${k}`;

/**
 * 秒 → 与 createLinkRegex 兼容的时间文本：236 → "03:56"，3723 → "1:02:03"。
 * 负数 / NaN / 小数都收敛成合法的秒数，写出来的链接一定解析得回来。
 */
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

/** 视频文件名 → 写进 {@...} 的关键词（去掉扩展名，与 findVideoFiles 的匹配口径一致） */
const keywordOf = (file) => path.basename(file, path.extname(file));

/**
 * 规整扩展名：补点号、去空格、转小写、丢空项。
 * 不做 String() 兜底 —— loadSettings 已经把 data.json 里的这一项规整成字符串数组了，
 * 这里是内部值，不是外部输入。
 */
function normalizeExtensions(list) {
    const out = [];
    for (const raw of list) {
        const s = raw.trim().toLowerCase();
        if (s) out.push(s[0] === '.' ? s : '.' + s);
    }
    return out;
}

/**
 * 拆「附加启动参数」：空格分隔，引号里的空格不算分隔（空串 → 空数组）。
 *
 * 引号两种写法都要认：只包住值（`--title="a b"`）与包住整个参数（`"a b"`）——
 * 两种都还原成「一个 argv 元素、里面的空格原样保留」。
 * 参数是直接交给 spawn 的 argv，不经过任何 shell，所以空格不需要额外转义。
 *
 * （VLC 版用的是 `/"([^"]*)"|(\S+)/g`：那个写法在 `--title="a b"` 上会让 `(\S+)`
 *  先吃掉 `--title="a`，把参数劈成两半 —— 只有整个参数被引号包住时才碰巧正确。
 *  这次实测发现并改正了它。）
 */
function parseExtraArgs(text) {
    return [...text.matchAll(/(?:[^\s"]|"[^"]*")+/g)].map((m) =>
        m[0].replace(/"([^"]*)"/g, '$1')
    );
}

/* ------------------------------------------------------------------ *
 *  链接 DOM（实时预览与阅读模式共用同一份构建逻辑）
 * ------------------------------------------------------------------ */

/**
 * 生成可点击的链接元素，显示为 (🎞关键词-03:22|04:33)。
 * 多个时间点时，每个时间点是**独立**的可点元素，点哪个跳哪个；点时间以外的部分
 * （关键词、括号）落在整条链接上，跳到第一个时间，保留「整条链接可点」的手感。
 *
 * onContextMenu（可选）：只给实时预览用。菜单里的「插入时间节点」「删除链接或时间节点」都需要
 * 知道右键落在哪条链接、**落在它的哪一部分**上，而实时预览里链接被换成了本 widget ——
 * widget 又会忽略编辑器事件（WidgetType.ignoreEvent 默认返回 true），右键不会把光标挪进来，
 * 所以由 widget 自己把「区间 + 点的是第几个时间点」报给插件（-1 = 点在关键词/括号上）。
 * 阅读模式没有编辑器菜单，不传这个回调。
 */
function buildLinkDom(keyword, times, onPlay, onContextMenu) {
    const wrap = document.createElement('span');
    wrap.className = 'mpv-linker-link';
    wrap.setAttribute('role', 'button');
    wrap.title = buildTooltip(keyword, times);

    // 编辑器本就不处理 widget 内部事件（WidgetType.ignoreEvent 默认返回 true），
    // 拦 mousedown 只是为了不让浏览器把焦点从编辑器上挪走。
    wrap.addEventListener('mousedown', (e) => e.preventDefault());
    wrap.addEventListener('click', (e) => {
        e.preventDefault();
        onPlay(times[0] ?? ''); // 点时间以外的部分 → 从头（或第一个时间）开始
    });
    if (onContextMenu) {
        wrap.addEventListener('contextmenu', (e) => {
            // 点在小时间块上 → 报它自己的序号；点在关键词/括号上 → -1
            // （鼠标事件的 target 一定是元素，不会是没有 closest 的文本节点）
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
        el.mpvLinkerTime = i; // 右键时用它认出「点的是第几个时间」
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation(); // 别落到 wrap 的「播第一个」上
            onPlay(t);
        });
        wrap.appendChild(el);
    });
    wrap.appendChild(document.createTextNode(')'));

    return wrap;
}

/* ------------------------------------------------------------------ *
 *  实时预览：替换装饰
 * ------------------------------------------------------------------ */

class MpvLinkWidget extends WidgetType {
    constructor(keyword, times, plugin, from = -1, to = -1) {
        super();
        this.keyword = keyword;
        this.times = times;
        this.plugin = plugin;
        this.from = from; // 这条链接在文档里的区间，右键时用来定位（阅读模式不传）
        this.to = to;
    }

    eq(other) {
        return (
            other.keyword === this.keyword &&
            other.times.join() === this.times.join() &&
            // 区间也要比：区间变了就得重造 DOM，否则它随身带着的「我是文档里的哪一处」会过期
            other.from === this.from &&
            other.to === this.to
        );
    }

    toDOM() {
        return buildLinkDom(
            this.keyword,
            this.times,
            (t) => this.plugin.playVideo(this.keyword, t),
            (timeIndex) => this.plugin.rememberLink(this.from, this.to, timeIndex)
        );
    }
}

/* ------------------------------------------------------------------ *
 *  代码 / 注释区间：写在这里面的 {@...} 一律不接管
 *
 *  实时预览拿到的是纯文本，没有现成的 DOM 结构可查，所以自己走一遍状态机。
 *  三种容器，判定顺序就是它们在文中出现的先后（谁先出现谁说了算）：
 *
 *    围栏代码块   ``` 或 ~~~，行首最多缩进 3 个空格，直到配对的收栏行
 *    行内代码     `x`，靠**等长**的反引号串闭合（与 CommonMark 一致）
 *    注释         %% … %%，Obsidian 的注释语法
 *
 *  于是「%% 里的反引号」「围栏里的 %%」都不会被当成另一种语法 —— 与渲染器同一套优先级。
 * ------------------------------------------------------------------ */

const BLANK_REST = /^[ \t]*$/;

/** i 所在那一行的行尾（不含换行）；最后一行没有换行时就是文末 */
const lineEndAt = (text, i) => {
    const nl = text.indexOf('\n', i);
    return nl < 0 ? text.length : nl;
};

/** 行首的围栏标记：≤3 个空格后连续 ≥3 个 ` 或 ~ → { ch, len, from }；否则 null */
function fenceAt(text, start, stop) {
    let from = start;
    while (from < stop && from - start < 3 && text[from] === ' ') from++;

    const ch = text[from];
    if (ch !== '`' && ch !== '~') return null;

    let end = from;
    while (end < stop && text[end] === ch) end++;
    return end - from >= 3 ? { ch, len: end - from, from } : null;
}

/**
 * 围栏块结束位置（收栏那一行的行尾）：找「同类字符、不短于开栏、其后只有空白」的行。
 * 找不到（没写收栏）→ 到文末，与渲染器把未闭合代码块一直吃到结尾的行为一致。
 */
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

/**
 * 从 from 往后找「长度恰好等于 len」的反引号串 —— CommonMark 规定只有等长的才能闭合。
 * 遇到空行就放弃（行内代码不跨段落），找不到返回 -1。
 */
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

/** 一行之内扫行内代码与注释，把命中的区间记进 out；返回继续扫描的位置（可能落在后面的行上） */
function scanInline(text, from, stop, out) {
    let i = from;
    while (i < stop) {
        if (text[i] === '`') {
            let len = 0;
            while (text[i + len] === '`') len++;
            const close = findBacktickRun(text, i + len, len);
            if (close < 0) {
                i += len; // 没闭合的反引号只是普通字符（CommonMark 也这么看）
                continue;
            }
            out.push({ from: i, to: close + len });
            i = close + len;
            continue;
        }
        if (text[i] === '%' && text[i + 1] === '%') {
            // 未闭合的 %% 会把后面整篇都吃掉 —— 这也是 Obsidian 自己的行为
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

/** 全文里所有「代码 / 注释」区间，按起点升序、互不重叠 */
function findBlocked(text) {
    const out = [];
    const n = text.length;

    for (let i = 0; i < n; ) {
        const stop = lineEndAt(text, i);

        // 行首的围栏：整块跳过，不必逐行扫
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
        i = next > stop ? next : stop + 1; // 行内代码/注释可能把位置推到后面某一行
    }
    return out;
}

/**
 * 纯文本里的所有该被接管的 {@...}（位置 + 关键词 + 时间点），不做光标判定。
 *
 * 扫全文而不是只扫可见区：围栏代码块可能从视口上方就开始了，只看可见区会把代码块里的
 * 语法当成链接。全文扫是线性的（一遍字符 + 一遍正则），代价比猜错小得多；
 * 装饰集覆盖全文，CodeMirror 只会渲染可见处那部分，滚动也就不必重算。
 *
 * 实时预览传的是 CM6 state，右键菜单传的是 editor.getValue()，两边共用这一份判定。
 */
function scanTextLinks(text) {
    // 绝大多数笔记里压根没有这个语法：一次原生子串查找就退出，状态机都不用跑
    if (!text.includes('{@')) return [];

    const blocked = findBlocked(text);
    const out = [];
    const re = createLinkRegex();
    let b = 0;

    for (let m; (m = re.exec(text)); ) {
        const to = m.index + m[0].length;
        // blocked 有序且互不重叠：指针只往前走，整体仍是 O(n)
        while (b < blocked.length && blocked[b].to <= m.index) b++;
        if (b < blocked.length && blocked[b].from < to) continue; // 落在代码/注释里 → 保留原文
        out.push({ from: m.index, to, keyword: m[1], times: splitTimes(m[2]) });
    }
    return out;
}

const scanLinks = (state) => scanTextLinks(state.doc.toString());

/**
 * 光标区间与链接区间「相触」——包括只贴在两侧边界上：
 * 刚敲完 `}`、光标正停在它后面时就属于这种，此时保留原文，方便继续改。
 */
const touches = (link, sel) => sel.from <= link.to && sel.to >= link.from;

const touchesAny = (links, sel) => links.some((l) => touches(l, sel));

/**
 * 链接里各时间点在文档中的绝对区间，与 link.times 一一对应。
 * {@k&03:22|07:23} 从 4 开始 → [{from: 9, to: 14}, {from: 15, to: 20}]
 * （`{@` 与关键词之后是 `&`，其后每个时间点前都有一个分隔符）
 */
function timeRangesAt(from, keyword, times) {
    let at = from + 2 + keyword.length;
    return times.map((t) => {
        at += 1; // 跳过 & 或 |
        const range = { from: at, to: at + t.length };
        at += t.length;
        return range;
    });
}

/**
 * 选区落在**第几个**时间点上（没落在任何时间点上 → -1，也就是落在关键词、`{@`、`&`、`|` 上）。
 * 用半开区间 [from, to)：右边界留给紧随其后的 `|` 或收尾的 `}`，
 * 这样「光标停在 `}` 后面」不会被误判成「点在最后一个时间点上」。
 */
const timeIndexAt = (ranges, sel) => ranges.findIndex((r) => sel.from < r.to && sel.to >= r.from);

/** 「去掉第 index 个时间点」之后的链接源码；一个不剩时回到只有关键词的形态 */
const linkTextWithoutTime = (link, index) => {
    const times = link.times.filter((_, i) => i !== index);
    return times.length ? `{@${link.keyword}&${times.join('|')}}` : `{@${link.keyword}}`;
};

/**
 * 「追加一个时间点」之后的链接源码，时间点按**先后**排序 —— 手写时排乱的也会被理一遍。
 * 按秒比而不是按字符串比：`10:00` 与 `1:30:00` 这类混用格式，字典序排出来是错的。
 * （Array#sort 是稳定的，所以两个时间相等时保持原有先后，不会来回换位。）
 */
const linkTextWithTime = (link, time) => {
    const times = [...link.times, time].sort(
        (a, b) => parseTimeToSeconds(a) - parseTimeToSeconds(b)
    );
    return `{@${link.keyword}&${times.join('|')}}`;
};

function buildDecorations(links, sel, plugin) {
    const builder = new RangeSetBuilder();
    for (const l of links) {
        if (touches(l, sel)) continue; // 保留 {@...} 原文
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

/* ------------------------------------------------------------------ *
 *  mpv.net 本地远程接口（Windows 命名管道 + JSON IPC）
 *
 *  协议：每条消息一行 JSON，以 \n 结尾。发命令
 *      {"command":["get_property","filename"],"request_id":1}
 *  收应答
 *      {"data":"xxx.mp4","request_id":1,"error":"success"}
 *  事件（"event":…）会随时插进来，所以**只认带 request_id 的那一条**。
 *
 *  mpv 比 VLC 的 HTTP 接口干净的地方：`path` 直接给完整路径，
 *  不用像 VLC 那样再去 playlist.json 里按 plid 对号。
 * ------------------------------------------------------------------ */

/** 命名管道的完整路径（供 spawn 的参数与 net.connect 共用同一份拼法） */
const pipePathOf = (name) => INPIPE_ROOT + name;
/** 第 i 条通道的名字 —— 与设置里的基准值一起决定 */
const pipeNameOf = (base, i) => PIPE_PREFIX + (base + i);

/**
 * 发一组命令并收齐应答，返回 { exists, replies }：
 *   exists  —— 这条管道**确实存在**（连上了）。false = 名字没人占，可以放心交给新窗口。
 *              ⚠️ 判据只有 ENOENT。任何其它结果（超时、EACCES、连接被重置）都记成
 *              「存在」—— 把一条被别的东西占着的管道交给新窗口只会绑定失败，
 *              结果那个窗口永远无法复用，之后每次点击都白跑一轮探测。
 *   replies —— request_id → { error, data }
 * 任何失败都不抛异常，调用方只判字段，不必写 try/catch。
 */
function mpvIpc(pipeName, commands, timeoutMs = TIMING.ipcTimeout) {
    return new Promise((resolve) => {
        let settled = false;
        let exists = true; // 只有拿到 ENOENT 才改成 false（见上面的说明）
        let buf = '';
        const replies = {};

        const done = () => {
            if (settled) return; // error 与超时可能都来，只认第一个结论
            settled = true;
            clearTimeout(timer);
            try {
                sock.destroy();
            } catch {
                /* 已经断了 */
            }
            resolve({ exists, replies });
        };

        const sock = net.connect(pipePathOf(pipeName));

        const timer = setTimeout(done, timeoutMs);

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
                    continue; // 半行 / 非法行：丢掉，不影响后面
                }
                // 事件也走这条管道，且随时会插进来 —— 没有 request_id 的一律当事件忽略
                if (typeof msg.request_id === 'number' && msg.request_id > 0) {
                    replies[msg.request_id] = msg;
                    if (Object.keys(replies).length === commands.length) return done();
                }
            }
        });

        sock.on('error', (err) => {
            if (err && err.code === 'ENOENT') exists = false; // 名字上什么都没有 → 空闲
            done();
        });
    });
}

/** 一次探测要问的三件事：在播什么、完整路径、播到第几秒 */
const PROBE_COMMANDS = [
    ['get_property', 'filename'],
    ['get_property', 'path'],
    ['get_property', 'time-pos'],
];

/**
 * 探一条通道，一次连接同时得到两件事：
 *   now  —— 它正在播什么（{ file, path, seconds }；没在播 / 不是 mpv → null）
 *   free —— 这条管道确实**没人占**，可以放心交给新窗口
 *
 * `time-pos` 在暂停或还没起播时是「属性不可用」，按 null 收 —— 调用方靠它区分
 * 「窗口在播、但进度读不到」（退路只给得出文件名的那种情况）。
 */
async function probeSlot(pipeName) {
    const { exists, replies } = await mpvIpc(pipeName, PROBE_COMMANDS);
    const ok = (n) => (replies[n] && replies[n].error === 'success' ? replies[n].data : null);

    const file = ok(1);
    return {
        pipe: pipeName,
        now: file
            ? {
                  file,
                  path: typeof ok(2) === 'string' ? ok(2) : null,
                  seconds: typeof ok(3) === 'number' ? ok(3) : null,
              }
            : null,
        free: !exists,
    };
}

/** 让这条通道上的 mpv 跳到第 seconds 秒，返回命令是否送达 */
async function mpvSeek(pipeName, seconds) {
    const { replies } = await mpvIpc(pipeName, [['set_property', 'time-pos', seconds]]);
    return !!(replies[1] && replies[1].error === 'success');
}

/**
 * 并行探一遍通道区间。
 * 并行而不是串行：空闲通道几毫秒就回，但万一有个「接了连接却不回应」的实例，
 * 串行会把 8 × ipcTimeout 全等一遍，点击后界面就一直没反应。
 */
const probeRange = (base) =>
    Promise.all(
        Array.from({ length: IPC_SLOT_COUNT }, (_, i) => probeSlot(pipeNameOf(base, i)))
    );

/**
 * 从探好的区间里挑出**正在播东西**的那些，摊平成 currentPlayback 要的形状
 * （{ pipe, file, path, seconds }）。「正在播」= IPC 认得出来，见 probeSlot。
 */
const playingOn = (probed) =>
    probed.filter((p) => p.now).map((p) => ({ pipe: p.pipe, ...p.now }));

/**
 * 复用探测：并行探一遍通道区间，得出两个结论：
 *   match —— 哪条通道上的 mpv 正在播 target（没命中 → ''）
 *   free  —— 第一条**确实没人占**的通道名（给新窗口用）；全被占时为 ''
 */
async function scanMpv(base, target) {
    const probed = await probeRange(base);
    return {
        match: probed.find((p) => p.now?.file === target)?.pipe || '',
        free: probed.find((p) => p.free)?.pipe || '',
    };
}

/* ------------------------------------------------------------------ *
 *  退路：从 mpv.net 窗口标题里认媒体名
 *
 *  窗口可能是你从资源管理器直接双击打开的 —— 那种窗口**没有** --input-ipc-server，
 *  通道区间里根本不会有它，「插入视频」就会说读不到。可它的标题里带着文件名
 *  （实测：正在播的窗口标题就是媒体名本身；空闲窗口的标题是 `mpv.net`），
 *  写一条 {@关键词} 足够了。
 *
 *  代价：**读不到播放进度**（标题里没有），所以只有「插入视频」能用这条退路；
 *  另外要拉起一个 PowerShell（只在通道区间一无所获时才走），几百毫秒。
 * ------------------------------------------------------------------ */

const PS_MPV_TITLES =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    'Get-Process -Name mpvnet -ErrorAction SilentlyContinue ' +
    '| ForEach-Object { $_.MainWindowTitle }';

/**
 * 从一堆窗口标题里认出正在播的媒体名；没在播 → null（纯函数，好测）。
 *
 * mpv.net 实测有两种标题形态（不同版本 / 不同状态下都出现过），两种都要认：
 *   正在播        蜘蛛人托板断裂.mp4
 *   正在播(旧式)   蜘蛛人托板断裂.mp4 - mpv.net
 *   空闲          mpv.net
 * 所以：先剥掉 ` - mpv.net` 后缀，剩下的只要不是播放器自己的名字就当媒体名。
 */
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

/** 问一次 Windows：现在哪个 mpv.net 窗口在播什么（拿不到 → null） */
function mpvWindowTitle() {
    return new Promise((resolve) => {
        if (!Platform.isWin) return resolve(null); // 这条退路只有 Windows 实测过

        // 这里是控制台程序，windowsHide: true 才对（与启动 mpv.net 相反：那是 GUI 程序）
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

/* ------------------------------------------------------------------ *
 *  截图：工具函数
 * ------------------------------------------------------------------ */

/**
 * 源宽 → 目标宽度（0 = 按原始分辨率）。规则是用户定的：
 *   源宽 < 1920        → 原样
 *   1920 ≤ 源宽 < 3000 → 一律压到宽 1920
 *   源宽 ≥ 3000        → 才听设置：不操作 / 宽 2560 / 宽 1920
 * 三个分支的目标宽都不会超过源宽，所以「绝不放大」是算出来的、不是靠播放器自觉。
 * mpv 的 `--vf=scale=W:-1` 与 VLC 的 `--scene-width` 一样会忠实照做，不能指望它拒绝放大。
 */
function snapshotTargetWidth(sourceWidth, mode) {
    if (!(sourceWidth > 0)) return 0; // 没读到源宽就别乱缩
    if (sourceWidth < SNAP_WIDTHS['1k']) return 0;
    if (sourceWidth < SNAP_3K_WIDTH) return SNAP_WIDTHS['1k'];
    return SNAP_WIDTHS[mode] ?? 0;
}

/**
 * 截图文件名：关键词（截断）+ 视频内时间点 + 扩展名。
 * 关键词与冒号里的非法字符换成 `-`（`formatTime` 给的 03:28 在 Windows 上建不了文件）。
 */
function snapshotFileName(keyword, seconds, ext) {
    return `${snapShortName(keyword)}-${formatTime(seconds)}${ext}`.replace(SNAP_NAME_BAD, '-');
}

/**
 * 「截图保存目录」输入 → 规范的仓库相对路径。空字符串 = 没填 = 用 Obsidian 的附件默认位置。
 * 去掉首尾斜杠、把 `..` 挡在仓库内。**设置面板与 loadSettings 共用这一个** —— 两处各写一套
 * 收法的话，一处存成 `Z-附件/`、另一处按 `Z-附件` 去找，就永远找不到那个目录。
 */
function cleanFolderPath(v) {
    const trimmed = String(v ?? '').trim();
    if (!trimmed) return '';
    return normalizePath(trimmed)
        .replace(/^(\.\.\/)+/, '')
        .replace(/^\/+|\/+$/g, '');
}

/**
 * 从 JPEG 字节里读宽高（解析到 SOF 段就够）。
 * 读不出来 → null：调用方据此放弃缩放、直接用原图，而不是拿个错尺寸去算。
 * 只认 JPEG —— 格式是插件自己钉死的，多支持一种就等于多一条没人测的路径。
 */
function jpegSize(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = bytes[i + 1];
        // SOF0..SOF15，但 C4(DHT)/C8(JPG)/CC(DAC) 不是尺寸段
        if (
            marker >= 0xc0 &&
            marker <= 0xcf &&
            marker !== 0xc4 &&
            marker !== 0xc8 &&
            marker !== 0xcc
        ) {
            return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
        }
        const len = bytes.readUInt16BE(i + 2);
        if (len < 2) return null;
        i += 2 + len;
    }
    return null;
}

/**
 * JPEG 写完了吗（结尾是 EOI 标记 0xFFD9）。
 * 光看「文件存在」不够：mpv.net 正在写的那一瞬间文件也在那儿，读到的会是被截断的图。
 */
const isCompleteJpeg = (b) =>
    b.length > 4 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

/**
 * 删掉一棵目录（不存在也算成功）。只走异步 fs —— 同步 IO 会把渲染进程冻住。
 *
 * 失败会**重试**：Windows 上「文件刚被某个进程写完、句柄还没撒手」时 rm 会被拒
 * （EBUSY / EPERM），一次不成就放弃的话，截图临时目录里会慢慢攒下一堆空子目录
 * （真机实测出现过）。重试完还是不成就算了 —— 下次截图用新的唯一子目录，
 * onload 时还会再清一次。
 */
async function removeDir(dir, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
            return;
        } catch {
            if (i < attempts - 1) await sleep(150);
        }
    }
}

/** 唯一子目录名：同一毫秒连点两次也不会撞 */
let snapSeq = 0;
const snapDirName = () => `s${Date.now().toString(36)}-${(snapSeq++).toString(36)}`;

/**
 * 正在进行的截图数。收尾的「清空整个临时目录」必须避开别人正在等的那张图 ——
 * 连点两次右键时，后一次的子目录会被前一次的清理顺手删掉，然后报一句莫名其妙的失败。
 */
let snapBusy = 0;

/**
 * 目录里**编号最小**的那张图（没有 → null）。
 * 按数字前缀排而不是字典序：`10.jpg` 在字典序里会排到 `9.jpg` 前面，
 * 将来 mpv 换成不补零的命名就会取错帧。
 */
async function firstImageName(dir) {
    let names;
    try {
        names = await fs.promises.readdir(dir);
    } catch {
        return null; // 目录都没了：这一枪什么都没写
    }
    const imgs = names.filter((n) => SNAP_IMAGE_NAME.test(n));
    if (!imgs.length) return null;
    imgs.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    return imgs[0];
}

/* ------------------------------------------------------------------ *
 *  主插件
 * ------------------------------------------------------------------ */

class MpvLinkerPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new MpvLinkerSettingTab(this.app, this));

        /* 上一轮要是崩在半路（Obsidian 被杀、插件被禁用），临时目录里会留着几张图。
           在这里清一次，免得越积越多。不 await —— 清理不该挡插件的加载。 */
        void this.clearSnapDir();

        const plugin = this;

        /* ---------------- 渲染层 A：实时预览 ----------------
         *
         * 装饰只在必要时重建：
         *   · 文档变化，或实时预览开关切换 → 重扫全文
         *   · 只是光标动了 → 新旧光标都没碰到任何 {@...} 就整个跳过，
         *     免得按一下方向键就把整套 widget 重造一遍
         *   · 只是滚动 → 什么都不做（装饰集覆盖全文，新滚进来的部分本来就在里面）
         */
        this.registerEditorExtension(
            ViewPlugin.fromClass(
                class {
                    constructor(view) {
                        this.refresh(view); // links / sel / decorations 都由它设好
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

        /* ---------------- 渲染层 B：阅读模式 ---------------- */
        this.registerMarkdownPostProcessor((el) => {
            if (el.textContent.includes('{@')) this.renderLinks(el);
        });

        /* ---------------- 渲染层 C：编辑器右键菜单 ----------------
         * 「MPV Linker」→「插入视频」/「插入时间节点」。
         *
         * 另一个监听是给 linkHint 兜底的：右键落在别处时把它清掉，免得后来拿这次
         * 记住的链接去做「追加时间」。用**捕获阶段**是为了不被别人拦住 ——
         * 要是哪个上层监听器 stopPropagation 了，冒泡版就永远收不到这个事件，
         * 提示就会一直留着过期。反正「落在别处」时 widget 那条回调也不会触发，
         * 两种阶段的先后顺序都不影响结果。
         */
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor) =>
                this.buildEditorMenu(menu, editor)
            )
        );
        this.registerDomEvent(
            document,
            'contextmenu',
            (e) => {
                // 右键落在别处 → 忘掉上次记住的链接。没有记录时直接返回，省掉一次 DOM 查询
                // （这个监听会收到全应用的右键，虽然只是一次 closest，也让它尽早返回）
                if (this.linkHint && !e.target.closest('.mpv-linker-link')) this.linkHint = null;
            },
            true
        );
    }

    /* ------------------------------------------------ 阅读模式渲染 */

    /** 把元素内文本节点里的 {@...} 换成可点击元素 */
    renderLinks(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                // 文本节点一定挂在元素上（树结构保证的），不必再判 parentElement 是否为空
                return node.nodeValue.includes('{@') &&
                    !node.parentElement.closest(SKIP_SELECTOR)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            },
        });

        // 先收集再改 DOM，避免边遍历边改写
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
                buildLinkDom(keyword, splitTimes(m[2]), (t) => this.playVideo(keyword, t))
            );
            last = m.index + m[0].length;
        }

        // 只出现 "{@" 未必构成合法链接（如没闭合的 {@abc）→ 原文保持不动
        if (!frag) return;
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }

    /* -------------------------------------------------------- 播放 */

    async playVideo(keyword, time) {
        const dir = this.settings.videoDirectory;
        const mpvPath = this.settings.mpvPath || 'mpvnet';

        /** 弹提示并放弃本次播放 */
        const fail = (msg) => {
            new Notice('MPV Linker：' + msg);
        };

        if (!dir) return fail('请先在设置里填写「视频文件目录」');

        /* 一律走异步：同步 IO（existsSync / readdirSync）跑在渲染进程里，会把 Obsidian
           的界面整个冻住，用户看到的是「点了完全没反应」。
           mpvPath 是绝对路径时才需要探 —— spawn 的 ENOENT 是异步事件，用户看不到原因。 */
        const { dirOk, hits } = await this.findVideoFiles(dir, keyword);
        if (!dirOk) return fail(`视频目录不存在或无法读取 → ${dir}`);
        if (/[\\/]/.test(mpvPath) && !(await fileExists(mpvPath))) {
            return fail(`找不到 mpv.net 可执行文件 → ${mpvPath}`);
        }
        if (!hits.length) return fail(`未找到文件名包含「${keyword}」的视频`);
        // 命中多个时不猜：把全部命中的视频名称摊开给用户看，由他把关键词写精确后再点一次
        if (hits.length > 1) return this.notifyAmbiguous(keyword, hits);

        const file = hits[0];
        const seconds = parseTimeToSeconds(time);
        const base = this.settings.mpvIpcBase; // loadSettings 已规整成 ≥ 0 的整数

        let free = '';
        if (base > 0) {
            const r = await this.reuseWindow(base, file, seconds, time);
            if (r.reused) return;
            free = r.free;
        }

        new Notice(`▶ ${path.basename(file)}${time ? ' @ ' + time : ''}`, PLAY_NOTICE_MS);
        const child = this.launchMpv(mpvPath, file, seconds, free);
        // 通道名记下来：再点同一视频时直接问这一条，不必整轮探
        this.lastLaunch = { file, at: Date.now(), pipe: free, child };

        /* 窗口一关掉就忘掉这次启动。否则再点同一视频时，会以为「mpv 正在启动、管道还没就绪」
           而白等一整个重试窗口 —— 实测那一下就是 1.5 秒，且每点一次都慢。
           子进程的 exit 是这件事唯一可靠的信号（spawn 直接失败走 error，不会发 exit）。 */
        const forget = () => {
            if (this.lastLaunch && this.lastLaunch.child === child) this.lastLaunch = null;
        };
        child.on('exit', forget);
        child.on('error', forget);
    }

    /**
     * 已经有窗口在播同一个视频？→ 直接 seek，返回 { reused: true }，不再开新窗口。
     * 否则返回 { reused: false, free }：free 是第一条空闲通道（全忙为 ''，此时新窗口
     * 干脆不带 IPC，免得绑定失败变成一个不可控的窗口）。
     *
     * 先快后慢两步：
     *   1. 刚才就是本插件把这个视频的窗口拉起来的 → 通道名已知，只问那一条。
     *      mpv.net 起来到管道就绪有几百毫秒（实测 ≈ 650ms，比 VLC 的 214ms 慢三倍），
     *      用户连点两个时间点时正好撞上，所以留一个重试窗口，不重试就会多开出第二个窗口。
     *      **那个窗口一旦被关掉就立刻停止等待**（下面的 lastLaunch 判定）——
     *      等的对象都不在了，继续等只是让用户白等一秒多。
     *   2. 其余情况才整轮探通道 —— 窗口可能是用户自己开的，也可能是上一次 Obsidian
     *      会话留下的，通道名无从得知。
     */
    async reuseWindow(base, file, seconds, time) {
        const target = path.basename(file);
        const launched =
            this.lastLaunch &&
            this.lastLaunch.file === file &&
            Date.now() - this.lastLaunch.at < TIMING.launchFreshMs
                ? this.lastLaunch
                : null;

        if (launched && launched.pipe) {
            const until = Date.now() + TIMING.launchRetryMs;
            do {
                if ((await probeSlot(launched.pipe)).now?.file === target) {
                    if (await mpvSeek(launched.pipe, seconds)) {
                        new Notice(`⏩ 已有窗口在播，跳到 ${time || '00:00'}`, PLAY_NOTICE_MS);
                        return { reused: true, free: '' };
                    }
                    break; // 通道在、命令没送达（mpv 正在退出等）→ 落到下面开新窗口
                }
                // 窗口已被关掉（exit 回调把 lastLaunch 置空）→ 管道不会再起来，别等了
                if (this.lastLaunch !== launched) break;
                await sleep(TIMING.pollMs);
            } while (Date.now() < until);
        }

        const { match, free } = await scanMpv(base, target);
        if (match && (await mpvSeek(match, seconds))) {
            new Notice(`⏩ 已有窗口在播，跳到 ${time || '00:00'}`, PLAY_NOTICE_MS);
            return { reused: true, free: '' };
        }
        return { reused: false, free };
    }

    /**
     * 命中多个：弹一条常驻提示（duration 0 = 点一下才消失），逐行列出视频名称。
     *
     * 用 DocumentFragment 而不是 "\n" 拼出的字符串：Notice 对字符串是整体 textContent，
     * 换行是否保留取决于主题 CSS；片段能让每个名称独占一行，也便于单独加样式。
     *
     * tail 是「没做的那件事」：点击播放时是「未播放」，右键定位文件时是「未打开文件夹」——
     * 两种情况都不猜是哪一个，只是如实说出什么都没做。
     */
    notifyAmbiguous(keyword, hits, tail = '未播放') {
        const frag = document.createDocumentFragment();
        /** 往提示里加一行；class 只在需要时给 */
        const line = (text, cls) => {
            const el = frag.appendChild(document.createElement('div'));
            if (cls) el.className = cls;
            el.textContent = text;
            return el;
        };

        line(`MPV Linker：「${keyword}」命中 ${hits.length} 个视频，${tail}`);
        const list = line('', 'mpv-linker-notice-list');
        // 只列文件名、不带目录：名称才是你用来区分视频的东西，目录前缀在窄提示里会占掉两行
        for (const p of hits) list.appendChild(document.createElement('div')).textContent = path.basename(p);
        line('把链接里的关键词写得更精确，即可只命中其中一个', 'mpv-linker-notice-tip');

        new Notice(frag, 0);
    }

    /**
     * 唯一可靠的失败信号是 spawn 的 error 事件（路径错、权限不足都是异步的）。
     * 返回子进程本身：调用方要拿它判断「这个窗口还在不在」。
     *
     * 参数顺序有讲究（与 VLC 版同一套约定）：用户的「附加启动参数」排在**前面**，
     * 远程接口那两个永远在最后 —— 用户不该（也很难有意地）把自己窗口的 IPC 顶掉。
     *
     * ⚠️ `--process-instance=multi` 是**必须显式带上**的：mpv.net 手册里这一项的
     * 默认值是 `single`（`single` = 强制单实例，第二个进程会把文件交给已存在的实例然后自己退出）。
     * 本机用的 mpv.net-DW 在 mpvnet.conf 里把它改成了 multi 所以看不出问题，
     * 但换台电脑就会退化成「第二个窗口根本开不出来」。
     * 实测：带上它之后，多个实例各占自己的管道、互不干扰。
     */
    launchMpv(mpvPath, videoPath, seconds, pipeName) {
        const args = [
            videoPath,
            `--start=${seconds}`,
            ...parseExtraArgs(this.settings.mpvExtraArgs),
        ];

        // 带上 IPC 通道，下次点同一视频就能直接 seek 而不是再开一个窗口
        if (pipeName) {
            args.push('--process-instance=multi', `--input-ipc-server=${pipePathOf(pipeName)}`);
        }

        /*
         * windowsHide 显式给 false，这一条是承重的（VLC 版实测过，mpv.net 同理）：
         * mpvnet.exe 是 GUI 程序，libuv 会把 true 翻译成 STARTF_USESHOWWINDOW + SW_HIDE，
         * 播放器创建自己的主窗口时会采用这个默认显示方式 —— 于是窗口根本不出现、只在后台出声。
         * 用 .NET 的 Process.MainWindowHandle（它只报**可见**的顶层窗口）实测过：
         *   windowsHide:true  → 0（没有可见窗口）
         *   windowsHide:false → 有句柄，标题是视频名
         * 加 detached 也改变不了这个结论。
         * detached 让它脱离 Obsidian 的进程组，成为独立的顶层窗口；
         * stdio:'ignore' + unref 让 Obsidian 不持有这个长命子进程。
         */
        const child = spawn(mpvPath, args, {
            windowsHide: false,
            detached: true,
            stdio: 'ignore',
        });

        child.on('error', () =>
            new Notice('MPV Linker：启动 mpv.net 失败，请检查设置中的播放器路径')
        );
        child.unref();
        return child;
    }

    /* ------------------------------------------------- 右键插入 */

    /**
     * 右键菜单：一个「MPV Linker」，下挂五个子项。
     *
     * **顺序是用户指定的**（沿用 VLC 版 2026-09-18 的调整，按使用频率排）：
     * 插入视频 → 插入时间节点 → 删除链接或时间节点 → 插入截图 → 在系统资源管理器中显示。
     * 图标名走 Lucide（Obsidian 内置那套），与含义一一对应：
     *   film / clock / scissors / camera / folder-open。
     * 换顺序或加项时留意：`logic.test.js` 里按**标题**取子项，不按下标 —— 但
     * `[24]` 有一条**顺序**断言钉着上面这个次序，改顺序要同步改它。
     *
     * hint（刚才右键落在哪条链接、哪个时间点上）在**菜单构建时**就取好：只有右键那一瞬间
     * linkHint 才是可信的，菜单开着的时候用户还可能去别处右键。
     */
    buildEditorMenu(menu, editor) {
        const hint = this.linkHint;
        menu.addItem((item) => {
            item.setTitle('MPV Linker').setIcon('play');
            // 子菜单是较新的 API：万一没有，退回平铺几项，功能不受影响
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
                    .onClick(() => this.captureFrame(editor, hint))
            );
            sub.addItem((i) =>
                i.setTitle('在系统资源管理器中显示')
                    .setIcon(FOLDER_ICON)
                    .onClick(() => this.revealInExplorer(editor, hint))
            );
        });
    }

    /**
     * 右键落在某个**已渲染出来的**链接上 → 记下它在文档里的区间、以及点的是第几个时间点
     * （-1 = 点在关键词或括号上，见 buildLinkDom）。用之前要拿文档校验，见 resolveTarget。
     * 只有实时预览的 widget 会调它（阅读模式不传回调），所以 from/to 一定是有效区间。
     */
    rememberLink(from, to, timeIndex) {
        this.linkHint = { from, to, timeIndex };
    }

    /**
     * 当前正在播放的 mpv.net → { pipe, file, path, seconds }；读不到 → null。
     *
     * 两步：先问通道区间（能同时拿到文件名、完整路径与**播放进度**），一无所获时退一步看
     * 窗口标题（只有文件名，`seconds` 为 null —— 见 mpvWindowTitle 的说明）。
     * 第二步是必要的：从资源管理器双击打开的视频不在通道区间里，用户会以为「mpv 明明开着」。
     *
     * 多个窗口同时在播时，优先取「本插件最近启动的那个」：IPC 不会告诉我们哪个窗口在前台，
     * Windows 又没有免 P/Invoke 的前台窗口查询可用（本机 Add-Type 被安全策略禁掉）。
     * 8 条通道并行问，最坏耗时就是一个 ipcTimeout。
     */
    async currentPlayback() {
        const base = this.settings.mpvIpcBase;
        if (base > 0) {
            const playing = playingOn(await probeRange(base));
            if (playing.length) {
                // 优先「本插件最近启动的那个」窗口（lastLaunch 可能为空，那时取第一条）
                const recent = playing.find(
                    (p) => this.lastLaunch && p.pipe === this.lastLaunch.pipe
                );
                return recent || playing[0];
            }
        }

        const titled = await mpvWindowTitle();
        return titled ? { pipe: '', file: titled, path: null, seconds: null } : null;
    }

    /**
     * 读不到播放状态时，说清**是哪一种**读不到 —— 两种情况的下一步动作完全不同，别混成一句。
     * 返回要提示的文案（三种之一）：
     *   NO_IPC_MESSAGE              —— 「复用窗口通道」填了 0，远程接口整个关着
     *   WINDOW_NOT_CAPTURED_MESSAGE —— 能认出一个窗口、但它不是插件开的
     *                                  （通道区间里没有它，只有标题退路读得到文件名）
     *   noPlaybackMessage           —— 真的没在播（调用方传自己的口径）
     *
     * 判据顺序不能换：通道关着时通道区间本就探不到东西，得先问这一条，
     * 否则会把「你把这个功能关了」误报成「窗口抓不到」。
     */
    async unreadablePlaybackReason(noPlaybackMessage) {
        if (this.settings.mpvIpcBase <= 0) return NO_IPC_MESSAGE;
        if (await mpvWindowTitle()) return WINDOW_NOT_CAPTURED_MESSAGE;
        return noPlaybackMessage;
    }

    /** 取当前播放的 mpv.net；取不到就给出提示（并说明为什么读不到） */
    async playingOrNotify() {
        const playing = await this.currentPlayback();
        if (playing) return playing;

        new Notice('MPV Linker：' + (await this.unreadablePlaybackReason(NO_MPV_MESSAGE)));
        return null;
    }

    /**
     * 右键位置对应的 {@...}（没有 → null）**以及点的是它的哪一部分**：代码块/注释里的不算。
     * 返回 { link, timeIndex }：timeIndex = -1 表示落在关键词/括号上，≥ 0 表示落在第几个时间点上。
     */
    resolveTarget(editor, hint) {
        const links = scanTextLinks(editor.getValue());

        // 1. 刚才右键确实落在渲染出来的链接上 → 用它记下的区间与序号；
        //    文档要是变过，这条会自然落空，落到下面按光标/选区算
        //    （linkHint 只由 rememberLink 写入，它一定会带上 timeIndex）
        if (hint) {
            const at = links.find((l) => l.from === hint.from && l.to === hint.to);
            if (at) return { link: at, timeIndex: hint.timeIndex };
        }

        // 2. 其余情况看光标/选区碰到了谁（源码模式，以及实时预览里链接还没被替换时）
        const sel = {
            from: editor.posToOffset(editor.getCursor('from')),
            to: editor.posToOffset(editor.getCursor('to')),
        };
        const link = links.find((l) => touches(l, sel));
        if (!link) return null;

        // 右键会选中点到的那个词，所以落在哪个时间点上是可以算出来的
        const ranges = timeRangesAt(link.from, link.keyword, link.times);
        return { link, timeIndex: timeIndexAt(ranges, sel) };
    }

    /** 右键位置对应的那条链接（没有 → null）。插入时间节点只关心是哪条，不关心点在哪一部分 */
    resolveLink(editor, hint) {
        const target = this.resolveTarget(editor, hint);
        return target ? target.link : null;
    }

    /**
     * 「插入视频」的位置守卫：这个位置已经有链接了吗？
     *
     * 两种问法不一样，别混：
     *   · 右键落在**渲染出来的**链接上（hint）→ 有。用户点的就是那条，插哪儿都不对。
     *   · 否则只看**光标是否落在链接内部** —— 贴着两端不算：光标停在 `}` 后面时，用户多半是想
     *     接着往下写，而不是「我正指着这条链接」。
     *     （渲染层用的闭区间 touches 是另一回事：它决定要不要把 `{@...}` 显示成原文，
     *      用户明确要求过贴着边界也保留原文。）
     */
    insertBlockedByLink(editor, hint) {
        const links = scanTextLinks(editor.getValue());
        if (hint && links.some((l) => l.from === hint.from && l.to === hint.to)) return true;
        const at = editor.posToOffset(editor.getCursor());
        return links.some((l) => l.from < at && at < l.to);
    }

    /**
     * 插入视频：读当前播放的文件名，写成 {@视频名称}。
     *
     * **位置已经有链接时不插**（光标在链接里，或右键落在链接上）。两种坏结果都遇到过：
     *   · 光标在远处、右键落在链接上 → 新链接插到了光标那里（用户以为插在右键的位置）；
     *   · 光标本来就在链接里 → 嵌进去变成 {@260422{@260414-…}}，语法坏掉。
     * 所以位置检查放在最前面 —— 它不依赖播放器，而且位置不行时这件事本来就做不了，
     * 没必要为此再问一遍 8 条通道。
     */
    async insertVideo(editor, hint) {
        if (this.insertBlockedByLink(editor, hint)) {
            return new Notice('MPV Linker：' + LINK_EXISTS_MESSAGE);
        }

        const playing = await this.playingOrNotify();
        if (!playing) return;

        const name = keywordOf(playing.file);
        if (KEYWORD_BAD.test(name)) return this.notifyBadKeyword(playing.file);
        this.insertText(editor, `{@${name}}`);
    }

    /**
     * 插入时间节点：
     *   · 右键落在已有的 {@...} 上 → 把当前时间追加进去（关键词与在播视频对不上就不动它）
     *   · 否则 → 在光标处新插一条 {@视频名称&时间}
     */
    async insertTimeNode(editor, hint) {
        const playing = await this.playingOrNotify();
        if (!playing) return;

        // 退路（窗口标题）只给得出文件名，给不出进度 —— 不编一个 0 秒去骗用户
        if (playing.seconds === null) {
            return new Notice('MPV Linker：' + WINDOW_NOT_CAPTURED_MESSAGE);
        }

        const name = keywordOf(playing.file);
        const time = formatTime(playing.seconds);
        const link = this.resolveLink(editor, hint);

        if (link) {
            // 关键词要对得上在播的视频才肯追加：否则用户以为在给「这条」补时间，其实补错了对象
            if (!name.includes(link.keyword)) {
                return new Notice('MPV Linker：该链接与mpv.net正在播放的视频名称不匹配！');
            }
            if (link.times.includes(time)) {
                return new Notice(`MPV Linker：这条链接里已经有「${time}」了`, PLAY_NOTICE_MS);
            }
            const text = linkTextWithTime(link, time); // 追加后按时间先后排序
            this.replaceRange(editor, link.from, link.to, text);
            return;
        }

        if (KEYWORD_BAD.test(name)) return this.notifyBadKeyword(playing.file);
        this.insertText(editor, `{@${name}&${time}}`);
    }

    /** 在光标处插入一段文本（光标停在插入内容之后，{@...} 保持源码形态，方便核对） */
    insertText(editor, text) {
        const at = editor.posToOffset(editor.getCursor());
        this.replaceRange(editor, at, at, text);
    }

    /**
     * 替换文档里的 [from, to) 并把光标放到新内容末尾。三处写文档的地方共用它，
     * 免得各写一遍「算偏移 → 替换 → 定位光标」。
     *
     * 光标必须**显式**放到新内容的末尾：默认的位置映射会留在插入点之前，
     * 而这里要的是「改完就停在改完的地方」（见 deleteLinkOrTime 里更详细的说明）。
     */
    replaceRange(editor, from, to, text) {
        editor.replaceRange(text, editor.offsetToPos(from), editor.offsetToPos(to));
        editor.setCursor(editor.offsetToPos(from + text.length));
    }

    /**
     * 删除链接或时间节点：
     *   · 右键落在关键词/括号上 → 整条 {@...} 删掉
     *   · 右键落在某个时间点上 → 只删那一个（删到最后一个时顺手去掉 `&`，回到 {@关键词}）
     *
     * **不读播放器**：删除纯粹是文档操作，mpv.net 开不开都该能用 —— 所以它不走
     * playingOrNotify()，「未获取到mpv.net视频」那句提示对删除是无意义的。
     *
     * 只删链接本身，不动紧邻的空格（多留一个空格是可见的、但可预料；悄悄吃掉用户打的空格更糟）。
     */
    deleteLinkOrTime(editor, hint) {
        const target = this.resolveTarget(editor, hint);
        if (!target) return new Notice('MPV Linker：这里没有 {@…} 链接可删');

        const { link, timeIndex } = target;
        const text = timeIndex >= 0 ? linkTextWithoutTime(link, timeIndex) : ''; // -1 = 整条删掉

        /* 先光标、后删除，顺序不能反。
         * 编辑会触发「把视口滚到光标处」，而右键落在渲染出来的链接上时编辑器并不会挪光标
         * （widget 忽略事件，见 buildLinkDom），于是光标可能还停在很远的地方 ——
         * 用户看到的就是「删掉第 100 行的链接，视图却跳回第 1 行」。
         * 先把光标放到链接末尾，视口就落在链接这里；replaceRange 再把光标落到新内容末尾。 */
        editor.setCursor(editor.offsetToPos(link.to));
        this.replaceRange(editor, link.from, link.to, text);
    }

    /** 文件名带了 {@…} 的保留字符，写不成链接 —— 说清是哪个文件，别让用户对着没反应发呆 */
    notifyBadKeyword(file) {
        new Notice(
            'MPV Linker：视频名里有 { } & | 之类的保留字符，没法写成链接 → ' +
                path.basename(file)
        );
    }

    /**
     * 在系统资源管理器中显示：打开命中视频所在的目录并选中那个文件。
     *
     * 位置不在链接上就什么都不做 —— 这个动作必须有明确的目标（链接里的关键词），
     * 不能靠「光标附近大概是哪个视频」去猜。命中多个时也不猜（与点击播放同一套提示）。
     * 和删除一样**不读播放器**：找文件与播放器状态无关，mpv.net 关着也该能用。
     */
    async revealInExplorer(editor, hint) {
        const target = this.resolveTarget(editor, hint);
        if (!target) return new Notice('MPV Linker：请在mpv.net视频链接上右键选择该命令！');

        const dir = this.settings.videoDirectory;
        if (!dir) return new Notice('MPV Linker：请先在设置里填写「视频文件目录」');

        const keyword = target.link.keyword;
        const { dirOk, hits } = await this.findVideoFiles(dir, keyword);
        if (!dirOk) return new Notice(`MPV Linker：视频目录不存在或无法读取 → ${dir}`);
        if (!hits.length) return new Notice('MPV Linker：指定目录下未匹配到相关视频！');
        if (hits.length > 1) return this.notifyAmbiguous(keyword, hits, '未打开文件夹');

        this.revealFile(hits[0]);
    }

    /**
     * 让系统文件管理器定位到这个文件：
     *   Windows  explorer /select,"<路径>"
     *   macOS    open -R <路径>
     *   Linux    xdg-open <目录>（文件管理器没有统一的「选中」入口，退一步开目录）
     * **只有 Windows 实测过**，另两个平台与 README 口径一致：理论可用、未验证。
     *
     * spawn 选项与启动 mpv.net 同一套：windowsHide 必须是 false（GUI 程序的窗口会被藏掉），
     * detached + stdio:'ignore' + unref 让它脱离 Obsidian 这条进程线。
     */
    revealFile(file) {
        // 用 Obsidian 的 Platform 而不是 process.platform —— 官方 plugin checklist 明确要求，
        // 而且它在移动端/未来平台上也是准的
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
            /* 只有 Windows 需要这一项，而且是承重的（实测过）：
             * explorer 要求 `/select,` 与路径在**同一个**参数里，而 libuv 默认会给含空格的参数
             * 整个加引号 —— 变成 "/select,F:\video\a b.mp4"，explorer 认不出这个开关，
             * 只会去打开「文档」目录。改成自己给路径加引号 + 让参数原样送达才对。
             * 注入方面：整段已被引号包住，而 Windows 文件名不可能含 `"`，所以拼不出额外参数；
             * 而且这里没有经过任何 shell，`&`、`^` 之类不会被解释。 */
            windowsVerbatimArguments: win,
        });
        // 与 launchMpv 同理：spawn 的失败是异步 error 事件，不接就只剩「点了没反应」
        child.on('error', () => new Notice('MPV Linker：打开系统文件管理器失败'));
        child.unref();
    }

    /* ------------------------------------------------- 插入截图 */

    /**
     * 右键「插入截图」的入口。落点决定结局：
     *   · 关键词 / 括号上（timeIndex < 0）→ 分两种（沿用 VLC 版用户指定的口径）：
     *       - 没有「与这条链接关键词同名」的在播视频 → 再分一层：
     *           标题退路读到**同名**窗口（双击打开的那种）→「窗口获取失败！…」；
     *           连这样的窗口都没有 → 保持原提示「请在时间节点上操作！」（用户原话，别改口径）；
     *       - 有同名在播视频 → 在**当前行下方插一个空行**，把「此刻」那一帧插进那个空行
     *         —— 用户的要求：光标的落点不该决定「能不能截」，只决定「插到哪儿」。
     *   · 时间节点上 → 截那一刻；
     *   · 空白处 → 截「最近那个 mpv.net 窗口正在播的那一帧」。
     */
    async captureFrame(editor, hint) {
        const target = this.resolveTarget(editor, hint);

        // ① 关键词 / 括号上：先看有没有同名在播视频，决定是「插下方」还是「照旧拒绝」
        if (target && target.timeIndex < 0) {
            const playing = await this.matchingPlaying(target.link.keyword);
            if (!playing) {
                /*
                 * 不能一律说「请在时间节点上操作」：同名视频**确实在播**、只是那个窗口是
                 * 双击打开的时候，用户看到前一句会以为是「没在播 / 操作位置不对」，
                 * 而真正的原因是「这个窗口插件抓不到」。两种情况下一步动作完全不同。
                 *
                 * 判据与其它几处一致：能认出一个窗口、但它不是我们开的（通道区间里没入口，
                 * 只有标题退路读得到）。标题退路给的是**媒体名**，所以照样用包含比对。
                 */
                const title = await mpvWindowTitle();
                if (title && title.includes(target.link.keyword)) {
                    return new Notice('MPV Linker：' + WINDOW_NOT_CAPTURED_MESSAGE);
                }
                return new Notice('MPV Linker：' + SNAP_TIME_ONLY_MESSAGE);
            }

            /*
             * 在当前行下方插一个空行，再把图插进去。
             *
             * 为什么不是「插到光标处」：光标这会儿紧贴 `}` 后面，直接插会把图片贴在那条链接
             * 屁股后面（`{@…&01:16}![](…)`），既不是用户要的排版，也让图片挤在链接行里。
             *
             * 分行手法沿用同作者的 hyc-editing 插件：取当前行文本 + 换行符，把**整行**替换掉
             * —— 等价于在行尾敲一次回车，光标自然落到新空行行首。
             * 这里不写死 `\r\n`：编辑器自己认 `\n`，而 CRLF 在 Obsidian 里会多出一个看不见的
             * 回车符。
             */
            const line = editor.getCursor().line;
            const lineText = editor.getLine(line);
            editor.replaceRange(
                lineText + '\n',
                { line, ch: 0 },
                { line, ch: lineText.length }
            );
            // 光标落到新空行行首，接着 captureVideo 的插入就走这一行
            editor.setCursor({ line: line + 1, ch: 0 });

            return this.captureVideo(editor, keywordOf(playing.file), playing.seconds, playing.path);
        }

        // ② 时间节点上：截那一刻
        if (target) {
            const { link, timeIndex } = target;
            return this.captureVideo(
                editor,
                link.keyword,
                parseTimeToSeconds(link.times[timeIndex]),
                null
            );
        }

        // ③ 空白处：先问 mpv.net 此刻在播什么、播到第几秒，再照着重截一帧
        const playing = await this.currentPlayback();
        if (!playing) {
            // 与 playingOrNotify 同一套分情况，只有「真没在播」那一句换成截图的口径
            return new Notice(
                'MPV Linker：' +
                    (await this.unreadablePlaybackReason(SNAP_NO_PLAYING_MESSAGE))
            );
        }
        // 退路（窗口标题）只给得出文件名、给不出进度，这条路上用不了 —— 如实提示，不编一个 0 秒
        if (!playing.pipe || playing.seconds === null || !playing.path) {
            return new Notice('MPV Linker：' + WINDOW_NOT_CAPTURED_MESSAGE);
        }

        // mpv 的 path 属性直接就是完整本地路径，不必像 VLC 那样再去播放列表里对号
        return this.captureVideo(editor, keywordOf(playing.path), playing.seconds, playing.path);
    }

    /**
     * 「与这个关键词同名的、此刻正在播的视频」——没有 → null。
     *
     * 「同名」的判据沿用链接匹配那套（关键词是**包含**关系，不相等）：用户的视频按
     * `YYMMDD-标题.mp4` 命名，链接里写的是其中一段，所以 `keyword.includes(keyword)` 才对得上。
     *
     * 只认**带 IPC 通道**的窗口（`pipe` 非空 且读得到秒数）：退路（窗口标题）给不出进度，
     * 截不了「此刻」那一帧，那种情况按「没有同名在播视频」处理，走原来的提示。
     */
    async matchingPlaying(keyword) {
        const playing = await this.currentPlayback();
        if (!playing || !playing.pipe || playing.seconds === null) return null;

        const name = keywordOf(playing.file);
        if (!name.includes(keyword)) return null;
        if (!playing.path) return null;

        return { file: playing.file, seconds: playing.seconds, path: playing.path };
    }

    /**
     * 找到视频 → 独立进程截一帧 → 落盘 → 插进笔记。
     * videoPath 非空时直接用（空白处那条路已经从 IPC 问到了完整路径）。
     */
    async captureVideo(editor, keyword, seconds, videoPath) {
        const mpvPath = this.settings.mpvPath || 'mpvnet';

        let video = videoPath;
        if (!video) {
            const dir = this.settings.videoDirectory;
            if (!dir) return new Notice('MPV Linker：请先在设置里填写「视频文件目录」');
            const { dirOk, hits } = await this.findVideoFiles(dir, keyword);
            if (!dirOk) return new Notice(`MPV Linker：视频目录不存在或无法读取 → ${dir}`);
            if (!hits.length) {
                return new Notice(`MPV Linker：未找到文件名包含「${keyword}」的视频`);
            }
            // 命中多个时不猜（与播放同一套提示），用户把关键词写精确了再点一次
            if (hits.length > 1) return this.notifyAmbiguous(keyword, hits, '未截图');
            video = hits[0];
        }

        // 与 playVideo 同一道守卫：路径是绝对路径却不存在时先明说，别让 spawn 的失败无声无息
        if (/[\\/]/.test(mpvPath) && !(await fileExists(mpvPath))) {
            return new Notice(`MPV Linker：找不到 mpv.net 可执行文件 → ${mpvPath}`);
        }

        try {
            const shot = await this.captureFrameAt(video, seconds);
            if (!shot) return new Notice('MPV Linker：' + SNAP_NO_IMAGE_MESSAGE);

            await this.saveSnapshot(editor, shot.bytes, keyword, seconds);
        } finally {
            /* 需求：插进笔记之后把临时目录清干净，为下次截图做好准备。
               用 finally —— 截不出来时也必须清：那种情况下的空目录会被下一次清理顺手带走，
               但「每次都失败」时就会一轮一轮往里叠。 */
            await this.clearSnapDir();
        }
    }

    /**
     * 用 mpv.net 的 image 视频输出截一帧，返回 { bytes, width, height }（失败 → null）。
     *
     * 为什么要两步：**宽度上限是真条件** —— mpv 的 `--vf=scale=W:-1` 会照着做，包括放大。
     * 所以第一枪按原始分辨率截，顺便从写出来的图里量出源宽；
     * 只有确实该缩、且目标宽与源宽不同，才补第二枪。选「先原图、需要才缩」是因为用户最常用的
     * 「不操作」与「源宽不到 3K」两种情况都只要一枪；反过来先缩再判断就永远要两枪。
     */
    async captureFrameAt(videoPath, seconds) {
        const mpvPath = this.settings.mpvPath || 'mpvnet';
        const dir = path.join(SNAP_ROOT, snapDirName());
        const scaledDir = dir + '-scaled';
        snapBusy++;

        try {
            await fs.promises.mkdir(dir, { recursive: true });
            const shot = await this.runImageOutput(mpvPath, videoPath, seconds, dir, 0);
            if (!shot) return null;

            const target = snapshotTargetWidth(shot.width, this.settings.snapshotResolution);
            if (!target || target === shot.width) return shot;

            await fs.promises.mkdir(scaledDir, { recursive: true });
            const scaled = await this.runImageOutput(
                mpvPath,
                videoPath,
                seconds,
                scaledDir,
                target
            );
            // 缩放那一枪没出图时留着原图 —— 有图总比只报错强
            return scaled || shot;
        } finally {
            await removeDir(dir);
            await removeDir(scaledDir);
            snapBusy--;
        }
    }

    /**
     * 起一次独立的 mpv.net：跳到 seconds、把帧写成图片、然后收掉它。
     * 返回编号最小的那张图 { bytes, width, height }（没出图 → null）；width 为 0 表示不缩放。
     *
     * 参数全是 mpv 自带的命令行选项，没有一处是本插件发明的：
     *   --vo-image-outdir=<目录>  输出目录 ⚠️ **必须排在 --vo=image 之前**（见下）
     *   --vo=image                image 视频输出负责把帧写成图片
     *   --vo-image-format / --vo-image-jpeg-quality   格式与画质
     *   --vf=scale=W:-1           缩放（只给宽，高按比例算）
     *   --start=<秒> / --frames=1  定位到目标秒、只要一帧
     *   --no-audio                不占音频设备
     *   --no-config               不读用户配置（否则断点续播 / 循环 / 滤镜都会渗进来）
     *   --window-minimized=yes    把窗口收起来（mpv.net 没有真正的无头模式，见文件头）
     *
     * ⚠️ 三条实测出来的硬约束，别凭推理改：
     *  1. **`--vo-image-outdir` 必须排在 `--vo=image` 之前**。顺序反了 mpv.net 会静默忽略
     *     输出目录，把图写进**进程的工作目录**（实测：目录是空的，图躺在 cwd 里，不报错）。
     *     这里再加一道保险：把子进程的 cwd 也设成输出目录，两头堵。
     *  2. **`--frames=1` 不保证生效**（它不是 property 开关）。实测同一个目录里出现过两张图，
     *     所以只认编号最小的那一张（见 firstImageName）。
     *  3. **它不会好好退出**：实测 5/7 次以 0xC0000005（访问违例）秒退、2/7 次挂住不退出，
     *     但两种情况**都发生在图写完之后**。所以收尾策略是「等图完整就自己 kill」，
     *     完全不依赖退出码 —— 拿退出码判成败会误报。
     */
    async runImageOutput(mpvPath, videoPath, seconds, dir, width) {
        const args = [
            videoPath,
            `--vo-image-outdir=${dir}`, // ⚠️ 必须排在 --vo=image 之前
            '--vo=image',
            `--vo-image-format=${SNAP_FORMAT}`,
            `--vo-image-jpeg-quality=${SNAP_QUALITY}`,
            ...(width ? [`--vf=scale=${width}:-1`] : []),
            `--start=${seconds}`,
            '--frames=1',
            '--no-audio',
            '--no-config',
            '--window-minimized=yes',
        ];

        /*
         * windowsHide: true —— 与启动播放窗口**恰好相反**：
         * 播放窗口必须 windowsHide:false 才会出现（承重项，见 launchMpv）；
         * 截图进程要的是「别让窗口跳出来打扰人」，再叠一层更稳（mpv.net 的主窗口本身还在，只是被最小化）。
         * cwd 设成输出目录：万一哪天 mpv.net 又把 --vo-image-outdir 忽略掉，图也会落在我们自己的
         * 临时目录里，不会被我们误读、也不会散到别处（见方法头的第 1 条）。
         * 不 detached：这个进程要能被我们收掉。
         */
        const child = spawn(mpvPath, args, { windowsHide: true, stdio: 'ignore', cwd: dir });

        let spawnFailed = false;
        child.on('error', () => (spawnFailed = true));

        let timer = null;
        let poll = null;

        await new Promise((resolve) => {
            let settled = false;
            let lastSize = -1;
            let stableSince = 0;

            /* exit / error / 超时三者只认第一个。注意**不看退出码**：崩退与挂住都出现过，
               而且都发生在出图之后，拿它判成败会误报。 */
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearInterval(poll);
                resolve();
            };
            const stop = () => {
                try {
                    child.kill();
                } catch {
                    /* 已经退出了 */
                }
                finish();
            };

            /* 超时基本只有两种可能：弹了模态框在等人点「确定」，或卡在解码上。
               杀掉收场 —— 否则会留下一堆幽灵 mpvnet.exe。 */
            timer = setTimeout(stop, TIMING.snapTimeoutMs);

            const check = async () => {
                if (settled) return;
                const name = await firstImageName(dir);
                if (!name) return;

                let size;
                try {
                    size = (await fs.promises.stat(path.join(dir, name))).size;
                } catch {
                    return; // 刚被换掉 / 还没落定，下一轮再看
                }
                // 先等「文件不再变大」——文件存在不等于写完，读到半张图就白截了
                if (size !== lastSize) {
                    lastSize = size;
                    stableSince = Date.now();
                    return;
                }
                if (Date.now() - stableSince < TIMING.snapStableMs) return;

                // 尺寸定住了再看结尾标记，双保险
                const bytes = await fs.promises.readFile(path.join(dir, name)).catch(() => null);
                if (bytes && isCompleteJpeg(bytes)) stop();
            };

            poll = setInterval(() => void check(), TIMING.snapPollMs);
            child.on('error', finish);
        });

        if (spawnFailed) return null;

        /* 收尾：确认它**真的退出了**再回去读图。
           图在轮询里已经确认写完并核过 EOI 了，所以这里等的是「句柄放开」而不是「图写完」
           —— 不放开的话，紧接着的 removeDir 会被 Windows 拒掉，临时目录就留在那儿了。 */
        await waitForExit(child, TIMING.snapExitGraceMs);
        return this.readFirstFrame(dir);
    }

    /**
     * 只认 FirstFrame（编号最小的那一张）：它是**定位帧**，多解出来的那些会抖动。
     * 见 runImageOutput 方法头的第 2 条。
     */
    async readFirstFrame(dir) {
        const name = await firstImageName(dir);
        if (!name) return null;

        try {
            const bytes = await fs.promises.readFile(path.join(dir, name));
            const size = jpegSize(bytes) || { width: 0, height: 0 };
            return { bytes, width: size.width, height: size.height };
        } catch {
            return null;
        }
    }

    /**
     * 把图片写进仓库并插到光标处。
     *
     * 落点交回 Obsidian 原生 API：不填「截图保存目录位置」时用
     * `fileManager.getAvailablePathForAttachment()` —— 它会照用户在「文件与链接」里的设置
     * （附件默认位置、以及「与当前文件同名的子目录」这类规则）算路径，重名自动加序号，
     * 比插件自己去读配置再拼路径可靠得多。填了目录就用那个目录（只在仓库内，见设置面板）。
     *
     * 链接写法同样交回 Obsidian：`generateMarkdownLink()` 按用户的「使用 Wiki 链接」与
     * 「新链接格式」设置生成，前缀一个 `!` 就是嵌入语法。
     */
    async saveSnapshot(editor, bytes, keyword, seconds) {
        const fm = this.app.fileManager;
        const note = this.app.workspace.getActiveFile();
        const sourcePath = note ? note.path : '';
        const name = snapshotFileName(keyword, seconds, '.' + SNAP_FORMAT);

        const folder = this.settings.snapshotFolder;
        let dest;
        if (folder) {
            // 目录必须是仓库里真实存在的文件夹：仓库外的图片插进笔记显示不出来（见设置面板）
            if (!(this.app.vault.getAbstractFileByPath(normalizePath(folder)) instanceof TFolder)) {
                return new Notice(`MPV Linker：${SNAP_FOLDER_MISSING_MESSAGE} → ${folder}`);
            }
            dest = this.availablePathIn(folder, name);
        } else {
            dest = await fm.getAvailablePathForAttachment(name, sourcePath);
        }

        const file = await this.app.vault.createBinary(dest, bytes);
        this.insertSnapshotLink(editor, `!${fm.generateMarkdownLink(file, sourcePath)}`);
    }

    /** 在指定目录里找一个不撞名的路径（同名就加 1、2…） */
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

    /**
     * 插到**光标处**。唯一例外：光标落在一条 {@...} 内部时挪到那条链接后面 ——
     * 右键点在链接上时编辑器会把光标停在点到的那段词末尾，正好在 {@...} 里面，
     * 硬插会把链接劈成两半，嵌在链接里的图片也点不开。
     */
    insertSnapshotLink(editor, markdown) {
        const at = editor.posToOffset(editor.getCursor());
        const inside = scanTextLinks(editor.getValue()).find((l) => l.from < at && at < l.to);
        const target = inside ? inside.to : at;
        this.replaceRange(editor, target, target, markdown);
    }

    /** 清空截图临时目录。有别的截图正在跑时不动手 —— 那会删掉它正在等的那张图 */
    async clearSnapDir() {
        if (snapBusy > 0) return;
        await removeDir(SNAP_ROOT);
    }

    /* ----------------------------------------------------- 文件查找 */

    /**
     * 关键词 → 命中的视频绝对路径（字典序，同一目录下的文件会排在一起）。
     * 返回 { dirOk, hits }：dirOk = false 表示根目录读不到（不存在 / 无权限），
     * 好跟「目录能读、只是没找到」区分开。
     *
     * 栈式深度遍历（不递归调用，深目录不会爆栈）；用 Dirent 判断类型、用 Set 判断扩展名，
     * 每个文件不额外 stat；readdir 走异步，不阻塞渲染进程。
     *
     * 不做目录缓存：本机 7 个文件实测 0.2~1 ms，为这点开销引入 TTL 缓存不划算，
     * 反而会带来「刚拖进目录的新视频几分钟内找不到」这种难解释的问题。
     */
    async findVideoFiles(dir, keyword) {
        const exts = new Set(normalizeExtensions(this.settings.videoExtensions));
        const hits = [];
        const stack = [dir];
        let rootOk = false;

        while (stack.length) {
            const current = stack.pop();
            let entries;
            try {
                entries = await fs.promises.readdir(current, { withFileTypes: true });
            } catch {
                continue; // 无权限 / 目录刚被删：跳过这一层，不打断整体搜索
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
                    /* 用 path.join 而不是 `current + path.sep + name`：用户粘进来的目录
                       可能是 `F:/video`、`F://video` 或末尾带斜杠的写法，直接拼会得到
                       `F://video\a.mp4` 这种盘符后带双斜杠的路径 —— 实测 mpv.net 加载不了它
                       （管道答得了话，但 filename / path / time-pos 全是 property unavailable，
                       症状像「窗口开出来了却什么都没播」，极难往路径上想）。
                       path.join 会把分隔符理成当前平台的标准写法。 */
                    hits.push(path.join(current, entry.name));
                }
            }
        }

        // 命中多个才排（默认比较器 = 字典序），单个命中时不做无谓排序
        if (hits.length > 1) hits.sort();
        return { dirOk: rootOk, hits };
    }

    /* ------------------------------------------------- 设置持久化 */

    async loadSettings() {
        const s = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        /* data.json 是外部输入（可能被手改过）：在**这里**把类型规整一次，之后内部代码直接信任
           settings 的形状，各处都不必再兜底 —— 所以纯函数里看不到 String() / || '' 这类判断。 */
        for (const key of ['videoDirectory', 'mpvPath', 'mpvExtraArgs', 'snapshotFolder']) {
            s[key] = String(s[key] ?? '');
        }
        /* 目录与播放器路径再收一道：用户会把 `F:/video`、`F://video`、末尾带斜杠之类的写法
           直接粘进来，而它们会被拼进「要 spawn 的可执行文件」与「要交给 mpv.net 打开的视频」。
           实测盘符后带双斜杠的路径会让 mpv.net **加载不了**（管道答得了话，但 filename /
           path / time-pos 全是 property unavailable，看着像「窗口开了却什么都没播」，
           完全指不到路径上），所以在入口处就理成平台标准写法。
           空串必须原样留着 —— path.normalize('') 会变成 '.'，那会指向「当前目录」。 */
        for (const key of ['videoDirectory', 'mpvPath']) {
            if (s[key]) s[key] = path.normalize(s[key]);
        }
        s.videoExtensions = Array.isArray(s.videoExtensions)
            ? normalizeExtensions(s.videoExtensions)
            : [...DEFAULT_SETTINGS.videoExtensions];
        const base = Math.floor(Number(s.mpvIpcBase));
        s.mpvIpcBase = base > 0 ? base : 0;

        // 下拉值只认白名单里那三个；data.json 被手改成别的值时回落到默认
        if (!Object.prototype.hasOwnProperty.call(SNAP_WIDTHS, s.snapshotResolution)) {
            s.snapshotResolution = DEFAULT_SETTINGS.snapshotResolution;
        }
        // 保存目录收成仓库相对路径（空 = 用附件默认位置），收法与设置面板共用 cleanFolderPath
        s.snapshotFolder = cleanFolderPath(s.snapshotFolder);

        this.settings = s;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

/* ------------------------------------------------------------------ *
 *  设置面板
 * ------------------------------------------------------------------ */

/**
 * 给输入框挂上「仓库目录联想」：边打边列出仓库里匹配的文件夹，点一下就填进去，
 * 效果与 Obsidian 自己的「文件与链接 → 新附件的默认位置」那个输入框一致。
 *
 * 用的是 Obsidian **官方导出**的 AbstractInputSuggest（与 AbstractTextComponent、App 等
 * 并列在 API 里）。万一运行时的 Obsidian 没导出它，就地退化成普通输入框 —— 手打路径照样能用，
 * 联想只是锦上添花，不该因为它而让设置面板报错。
 */
function attachFolderSuggest(app, inputEl, onPick) {
    if (typeof AbstractInputSuggest !== 'function') return null;

    return new (class extends AbstractInputSuggest {
        getSuggestions(query) {
            const q = query.trim().toLowerCase();
            return app.vault
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
    })(app, inputEl);
}

class MpvLinkerSettingTab extends PluginSettingTab {
    display() {
        const { containerEl } = this;
        const settings = this.plugin.settings;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'MPV Linker 设置' });

        const field = (name, desc, placeholder, value, save) =>
            new Setting(containerEl)
                .setName(name)
                .setDesc(desc)
                .addText((text) =>
                    text
                        .setPlaceholder(placeholder)
                        .setValue(value)
                        .onChange(async (v) => {
                            save(v);
                            await this.plugin.saveSettings();
                        })
                );

        /** 下拉框。options 形如 { 值: 显示文案 }，回写的是「值」 */
        const dropdown = (name, desc, options, value, save) =>
            new Setting(containerEl)
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
            '视频文件目录',
            '视频所在的本地目录绝对路径，递归搜索其所有子目录',
            '例如：D:\\Videos\\Trading',
            settings.videoDirectory,
            (v) => (settings.videoDirectory = v.trim())
        );

        field(
            'mpv.net 播放器路径',
            'mpvnet.exe 的完整路径；已加入 PATH 时直接写 mpvnet 也可以。' +
                '便携版通常形如 D:\\Tools\\MPV.net\\mpvnet.exe',
            'mpvnet',
            settings.mpvPath,
            (v) => (settings.mpvPath = v.trim())
        );

        field(
            '视频扩展名',
            '逗号分隔，例如：.mp4,.mkv,.avi',
            '.mp4,.mkv,.avi',
            settings.videoExtensions.join(','),
            (v) => (settings.videoExtensions = normalizeExtensions(v.split(',')))
        );

        field(
            'mpv.net 附加启动参数',
            '留空即可，空格分隔。例如 --ontop 让窗口一直压在最上面' +
                '（复用窗口时只能跳时间、无法把窗口带到前台，加这个参数保证看得见）',
            '留空',
            settings.mpvExtraArgs,
            (v) => (settings.mpvExtraArgs = v.trim())
        );

        field(
            '复用窗口通道',
            '已有 mpv.net 窗口正在播同一个视频时，直接跳转时间而不再开新窗口。' +
                '这需要 mpv.net 在本机开一条本地控制管道，实际用到的范围是该值起连续 8 个。' +
                '填 0 关闭此功能（每次都开新窗口）。',
            '18730',
            String(settings.mpvIpcBase),
            (v) => (settings.mpvIpcBase = Math.max(0, parseInt(v, 10) || 0))
        );

        containerEl.createEl('h3', { text: '插入视频截图' });

        dropdown(
            '截图分辨率≥3K时缩放操作(宽3000)',
            '源片宽度不到 1920 时保持原始分辨率与宽高比；1920~3000 之间一律压到宽 1920；' +
                '达到 3000（3K）以上才听这里的设置。任何情况都不会放大图片。' +
                '高度始终按原始宽高比自动换算，输出格式 jpg、质量 90。',
            SNAP_RESOLUTION_OPTIONS,
            settings.snapshotResolution,
            (v) => (settings.snapshotResolution = v)
        );

        /* 保存目录：输入框 + 仓库目录联想，与「文件与链接 → 新附件的默认位置」同一个行为。
           输入当场规整（cleanFolderPath），保证存下去的就是保存时拿去查的那个写法。 */
        new Setting(containerEl)
            .setName('截图保存目录位置')
            .setDesc(
                '留空 → 存到 Obsidian 的附件默认位置（「文件与链接 → 新附件的默认位置」）。' +
                    '也可以填仓库里的一个目录（边打边给建议），目录必须已存在，否则截图时会提示。'
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

        containerEl.createEl('h3', { text: '语法说明' });
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
    }
}

/* ------------------------------------------------------------------ *
 *  导出
 * ------------------------------------------------------------------ */

module.exports = MpvLinkerPlugin;

/* 供离线自测取用；Obsidian 只读 module.exports 本身，挂属性不影响加载 */
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
    FILM_ICON,
    CLOCK_ICON,
    SCISSORS_ICON,
    CAMERA_ICON,
    FOLDER_ICON,
    SNAP_ROOT,
    SNAP_FORMAT,
    SNAP_QUALITY,
    SNAP_IMAGE_NAME,
    SNAP_3K_WIDTH,
    SNAP_WIDTHS,
    SNAP_RESOLUTION_OPTIONS,
    SNAP_TIME_ONLY_MESSAGE,
    SNAP_NO_PLAYING_MESSAGE,
    SNAP_NO_IMAGE_MESSAGE,
    SNAP_FOLDER_MISSING_MESSAGE,
    SNAP_NAME_MAX,
    createLinkRegex,
    splitTimes,
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
    snapshotTargetWidth,
    snapshotFileName,
    jpegSize,
    isCompleteJpeg,
    firstImageName,
    cleanFolderPath,
    attachFolderSuggest,
    scanTextLinks,
    timeRangesAt,
    timeIndexAt,
    linkTextWithoutTime,
    linkTextWithTime,
    buildLinkDom,
    MpvLinkWidget,
    findBlocked,
};
