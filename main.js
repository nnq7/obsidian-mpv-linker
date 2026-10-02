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
 *  ⚠️ 截图 argv 的几条承重约束（全是真机实测出来的，别凭推理改；理由与实测数据见 runImageOutput）：
 *    · `--vo-image-*` 整族必须排在 `--vo=image` 之前（反了会**静默忽略**，图落到进程的 cwd）；
 *    · `--start` 必须配 `--no-resume-playback`（否则续播顶掉起点，还会删掉用户的存档）；
 *    · `--frames=1` 不可靠 → 只认编号最小的那张图；
 *    · mpv.net 没有真正的无头模式 → 只能 `--window-minimized=yes`；
 *    · `--process-instance=multi`、以及 `--` + 视频路径的次序同样是承重的。
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
     * 截图分辨率。取值 'none'（按原始分辨率）| '2k' | '1k' ——
     * 只有「源片总像素超过该档位」时才会缩放（见 snapshotScaleFilter），
     * 所以普通片子根本用不到它。
     */
    snapshotResolution: 'none',
    /*
     * 截图质量（传给 mpv 的 `--vo-image-jpeg-quality`）。用户 2026-09-22 要求做成滑块，
     * 取值范围 **20~100**（20 是下限：再低就糊得没有实用性），滑块右侧配一个「重置」按钮回到 90。
     * 100 = jpg 质量拉满（最接近无损、体积最大，**不换 png**），其余数值直接就是质量参数。
     * 默认 90 —— mpv 自带的默认就是 90（实测：显式 90 与不带参数输出逐字节同大小），
     * 所以这个默认值就等于「做成设置项之前」的行为。
     */
    snapshotQuality: 90,
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
 * 点的是**片名/括号**（而不是某个时间点）时，如果同名视频已经在播，就什么都不做。
 * 用户 2026-09-19 明确要求：那种情况不该「跳到第一个时间点」、更不该「从头重播」，只提示。
 * （点时间点仍然照常跳转 —— 那才是「我要看这一刻」的意思。）
 */
const ALREADY_PLAYING_MESSAGE = '已有同名视频正在播放！';

/**
 * 时间节点超出视频总时长时的提示（用户 2026-09-22 指定原话）。
 * 判断用 **大于**（用户明确要求）：时间点正好等于总时长是允许的。
 */
const DURATION_EXCEEDED_MESSAGE = '该时间点超出视频总时长！';

/*
 * 「删除链接或时间节点」必须**真的指到那条链接**才动手：光标只贴在链接两端
 * （尤其是紧贴在 `}` 后面）不算「指到链接」。两种情况共用这一句 —— 用户 2026-09-19 要求统一。
 */
const DELETE_HINT_MESSAGE = '请在视频链接上右键选择删除！';

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
 *
 * ⚠️ **按进程号隔离**（2026-10-03 票 13①）：两个 Obsidian 窗口（不同仓库）是两个进程，
 * 而 `snapBusy` 只是**进程内**变量。以前共用同一棵目录 → B 窗口的清理会把 A 窗口正在等的
 * 那张图连目录一起删掉（A 报一句「截图失败」，其实图是被删掉的）。
 * 加上进程号之后，`clearSnapDir()` 的 `removeDir(SNAP_ROOT)` 天然只清自己这一棵。
 * ⚠️ 另一条路（顺手清理别的进程留下的旧目录）**有意不做**（用户不同时开两个窗口，收益为零）——
 * 代价是崩溃残留会一直躺在 %TEMP% 里，但不影响后续截图：每张图都有自己的唯一子目录。
 */
const SNAP_ROOT = path.join(os.tmpdir(), 'mpv-linker-snap', String(process.pid));

/** 截图格式：用户要求 jpg */
const SNAP_FORMAT = 'jpg';

/**
 * 画质参数是 `--vo-image-jpeg-quality`（不是 `--sout-jpeg-quality` —— 那是 VLC 的叫法）。
 * ⚠️ **它的默认值就是 90**（实测：显式 90 与不带参数输出逐字节同大小、547617B），
 * 所以 90 既是 mpv 眼里的默认，也是这个设置项的默认值与「重置」的落点。
 * 取值范围 0~100；101 会被 mpv 拒绝并回落默认（stderr 打印 error setting property）。
 */
const SNAP_QUALITY = 90;

/**
 * 只认编号最小的那一张图（定位帧）。
 * ⚠️ `--frames=1` 不是 property 开关，mpv.net 不保证照做 —— 实测同一目录里出现过
 * 00000001.jpg 与 00000002.jpg 两张，多出来的会抖动，只有第一张是定位帧。
 */
const SNAP_IMAGE_NAME = /^\d+\.(?:jpg|jpeg|png|webp)$/i;

/** 「1K 级」像素总数（1920×1080）：选「缩放到 1k」时的**触发阈值兼目标** */
const SNAP_PX_1K = 1920 * 1080;
/** 「2K 级」像素总数（2560×1440）：选「缩放到 2k」时的**触发阈值兼目标** */
const SNAP_PX_2K = 2560 * 1440;
/**
 * 下拉取值 → 目标像素总数（0 = 不缩放，按原始分辨率）。
 * 这个数**同时是阈值和目标**：源片总像素不超过它 → 系数算出来正好是 1 → 原样输出
 * （见 snapshotScaleFilter 里的恒等式）。设置值仍是 'none' / '2k' / '1k'，
 * 老 data.json 不用改。
 *
 * ⚠️ 判据用**像素总数**而不是宽度（2026-09-22 用户拍板）：旋转只是交换宽高、乘积不变，
 * 所以竖屏片 —— 包括「横向编码 + 旋转元数据」那种 —— 完全不需要任何旋转判断。
 */
const SNAP_PX_TARGET = { none: 0, '2k': SNAP_PX_2K, '1k': SNAP_PX_1K };
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
/* 图出来了、但没能写进仓库（目录被删 / 同名竞争 / 权限）。2026-10-03 补 ——
   以前这种情况是「点了没反应」（未处理的 rejection）。文案风格与上面几条保持一致。 */
const SNAP_SAVE_FAILED_MESSAGE = '截图失败：图片没能写进仓库';
/** 自定义保存目录不在仓库里 / 不存在 */
const SNAP_FOLDER_MISSING_MESSAGE = '截图保存目录不存在';

/** 所有面向用户的提示共用的前缀 —— 文案口径要改只改这一处 */
const NOTICE_PREFIX = 'MPV Linker：';

/** 弹一条带插件前缀的提示；timeout 不传 = Obsidian 默认时长，0 = 常驻到点击 */
const notice = (msg, timeout) => new Notice(NOTICE_PREFIX + msg, timeout);

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
 *
 * 元素先过 String()：loadSettings 只验了「是不是数组」，**没验元素类型** ——
 * 手改过的 data.json 里出现数字 / null 时 `raw.trim` 会直接抛，而 loadSettings 跑在
 * onload 里，等于**整个插件起不来**。这里是最后一道，兜住它。
 */
function normalizeExtensions(list) {
    const out = [];
    for (const raw of list) {
        const s = String(raw ?? '').trim().toLowerCase();
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
 * （关键词、括号）落在整条链接上 —— 这一下的意思是「**我要播这个视频**」，
 * 所以 onPlay 会带上 `isKeywordClick = true`，插件据此在「同名视频已经在播」时拒绝重复播放。
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
        // 第二个参数 isKeywordClick = true：点的是片名/括号（整条链接），不是某个时间点
        onPlay(times[0] ?? '', true);
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
            // isKeywordClick = false：明确点了某一个时间点 → 「我要看这一刻」，照常跳转
            onPlay(t, false);
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
            (t, isKeywordClick) => this.plugin.playVideo(this.keyword, t, isKeywordClick),
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

        /* 按 utf8 解码，而不是让每个 chunk 各自 toString（2026-10-03 补）：
           一个中文字符跨在两个 chunk 边界上会被劈成两个替换符，那一行 JSON.parse
           失败后就被丢掉 —— 症状是「明明在播却说没在播」（视频名基本都是中文）。
           setEncoding 之后 buf 是字符串，Node 自己处理跨块的多字节序列。 */
        sock.setEncoding('utf8');

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

        /* 对端连上之后不回应、直接断开时也要早退（2026-10-03 补）：少了这一条就只能干等满
           ipcTimeout（700ms）。⚠️ 这里**不动 exists** —— 保持方法头那条约定：只有 ENOENT
           才算「空闲」，其它一律保守当成「被占着」。done 本身是幂等的（settled 守卫）。 */
        sock.on('close', done);
    });
}

/**
 * 一次探测要问的四件事：在播什么、完整路径、播到第几秒、**总时长**。
 * `duration` 只是同一批命令里多一项 —— 实测（`_tmp/mpv-probe/probe-props.cjs`）可读，
 * 不增加任何往返；用它来校验「时间节点有没有超出片长」。
 */
const PROBE_COMMANDS = [
    ['get_property', 'filename'],
    ['get_property', 'path'],
    ['get_property', 'time-pos'],
    ['get_property', 'duration'],
];

/**
 * 探一条通道，一次连接同时得到两件事：
 *   now  —— 它正在播什么（{ file, path, seconds, duration }；没在播 / 不是 mpv → null）
 *   free —— 这条管道确实**没人占**，可以放心交给新窗口
 *
 * `time-pos` 在暂停或还没起播时是「属性不可用」，按 null 收 —— 调用方靠它区分
 * 「窗口在播、但进度读不到」（退路只给得出文件名的那种情况）。`duration` 同理。
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
                  duration: typeof ok(4) === 'number' ? ok(4) : null,
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
 * 复用探测：得出两个结论 ——
 *   match —— 哪条通道上的 mpv 正在播 target（没命中 → ''）
 *   free  —— 第一条**确实没人占**的通道名（给新窗口用）；全被占时为 ''
 *
 * `probed`：调用方已经探好的结果（省掉这一轮，票 07）。
 * `isUsable`：调用方给的额外条件，用来跳过「刚被本插件预留、管道还没建起来」的通道
 *   （票 12）。条件从外面传进来，这个函数保持是纯的 —— 不在这里读插件状态。
 */
async function scanMpv(base, target, probed, isUsable) {
    const all = probed || (await probeRange(base));
    return {
        match: all.find((p) => p.now?.file === target)?.pipe || '',
        free: all.find((p) => p.free && (!isUsable || isUsable(p.pipe)))?.pipe || '',
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
 * 源尺寸 → 缩放用的 `--vf` 参数（null = 不缩放）。规则是用户定的（2026-09-22）：
 *
 *   下拉选「不操作」      → 不缩放（返回 null，连滤镜都不挂）
 *   下拉选「缩放到 2k」   → **总像素 > 2560×1440** 才缩；否则原样
 *   下拉选「缩放到 1k」   → **总像素 > 1920×1080** 才缩；否则原样
 *
 * 缩放系数 = √(目标像素 ÷ 原像素)，原宽与原高**同乘**这个系数（等比）。
 * 系数**不由 JS 截断成整数宽度**：那样对旋转视频会缩错轴（实测 4K 竖屏 2160×3840 会被
 * 缩成 608×1080 —— 见下面的说明），也会丢精度。
 *
 * ⚠️ **为什么系数交给 mpv 自己算**：`--vf=scale` 作用在**编码帧（旋转前）**上，而「原宽」
 * 到底是编码宽还是看到的宽，取决于容器里有没有旋转元数据 —— 插件不知道、也不想知道。
 * 用 `w=iw*系数` 这种**相对表达式**，mpv 用它自己帧的 `iw`，两种取向都自动正确：
 * 系数是等比缩放，旋转只交换宽高、不改变系数。
 *
 * `min(1, √(T/总像素))` 用恒等式写成 `√(2T / (T + 像素 + |T - 像素|))`：
 *   像素 ≥ T 时 → 分母 = 2×像素 → √(T/像素)（该缩就缩）
 *   像素 < T 时 → 分母 = 2T      → 1（不该缩就原样，**绝不放大**）
 * 之所以绕这么一圈：mpv 的 vf 参数里**逗号是过滤器分隔符**，`min(a,b)` 那种写法会被拒
 * （实测 `w=(iw*ih>=T ? iw : iw*0.5)` 直接被丢掉、静默不缩放）。这个写法只用算术 + sqrt + abs。
 *
 * 由此**一次截图只起一个进程**：不需要先截一枪量尺寸，也就没有第二次窗口。
 */
function snapshotScaleFilter(mode) {
    const targetPx = SNAP_PX_TARGET[mode] ?? 0;
    if (!targetPx) return null; // 「不操作」或取值不认识
    return (
        `scale=w=iw*sqrt(2*${targetPx}/(${targetPx}+iw*ih+abs(${targetPx}-iw*ih))):h=-1`
    );
}

/**
 * 截图质量的**下限**：20（用户 2026-09-22 要求）。质量给到 1 那种档位糊得没有实用性，
 * 所以滑块的取值范围是 **20~100**，收值规则也照这个下限来。
 */
const SNAP_QUALITY_MIN = 20;

/**
 * 把「用户设的截图质量」收成真正能用的值 —— 滑块、loadSettings、拼 mpv 参数**共用这一份规则**：
 *   0 或非法值 → 默认 90（0 是旧版滑块「用默认」那一档，老 data.json 里可能还留着）
 *   低于 20 的旧值（比如曾经设过的 1）→ **抬到 20**：那一档已经从界面上取消，留着只会得到废图
 *   其余 → 按数字走，上限 100
 *
 * 上限 100 是 mpv 自己的范围（实测 101 会被拒并回落默认），**不是**「无损」档：
 * 用户明确要的是「100 = jpg 质量 100」，不换成 png。
 */
function clampQuality(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_SETTINGS.snapshotQuality;
    return Math.min(100, Math.max(SNAP_QUALITY_MIN, n));
}

/** 真正传给 mpv 的那个值。与 clampQuality 同一套规则，只是在这里叫这个名字更好读 */
function resolveSnapQuality(v) {
    return clampQuality(v);
}

/* ------------------------------------------------------------------ *
 *  从容器里读总时长（不启动播放器就能知道片长）
 * ------------------------------------------------------------------ */

/** 定点读一小段，别把整个视频读进内存 */
async function readAt(fh, position, length) {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

/** timescale / duration → 秒；两者不合法或标记为「未知」时给 null */
function secondsFrom(timescale, duration, unknownMark) {
    if (!(timescale > 0)) return null;
    if (!(duration > 0) || duration === unknownMark) return null;
    const sec = duration / timescale;
    return Number.isFinite(sec) && sec > 0 ? sec : null;
}

/** 在 moov 的字节里找 mvhd 算出秒数（mvhd 一般紧跟 moov，给 64KB 足够） */
function mvhdDuration(buf) {
    const at = buf.indexOf('mvhd', 0, 'latin1');
    if (at < 0) return null;
    const p = at + 4; // 'mvhd' 占 4 字节，p 指向 version
    if (buf[p] === 1) {
        // v1：creation / modification / duration 都是 64 位 → timescale 在 +20、duration 在 +24
        if (p + 32 > buf.length) return null;
        const timescale = buf.readUInt32BE(p + 20);
        const duration = Number(buf.readBigUInt64BE(p + 24));
        return secondsFrom(timescale, duration, Number.MAX_SAFE_INTEGER);
    }
    // v0：全部 32 位 → timescale 在 +12、duration 在 +16
    if (p + 20 > buf.length) return null;
    return secondsFrom(buf.readUInt32BE(p + 12), buf.readUInt32BE(p + 16), 0xffffffff);
}

/**
 * ISO-BMFF（mp4 / mov / m4v）：顶层盒子跳着走，找到 `moov` 就读 `mvhd`。
 * ⚠️ `moov` 不一定在文件开头 —— 非 faststart 的 mp4 把它放在 `mdat` 之后，
 * 所以这里按盒子长度跳过 mdat（不读它的内容），别只认开头那几十 KB。
 */
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
            boxSize = size - pos; // 一直到文件尾
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

/** EBML 元素 ID 与长度（都是变长整数） */
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
            return { size: allOnes ? null : size, len }; // null = 「未知长度」
        }
    }
    return null;
}

/**
 * Matroska（mkv / webm）：Segment → Info → `Duration`(浮点) × `TimecodeScale` / 1e9。
 * `Duration` 是**时间码单位**，不是秒，必须乘 TimecodeScale（默认 1000000 ns）。
 * Segment 常写成「未知长度」，所以不能靠它的长度跳过，只能顺着子元素一个个走。
 */
function ebmlDuration(buf) {
    let p = 0;
    let info = null;

    {   // EBML 头
        const id = ebmlId(buf, p);
        if (!id || id.id !== 0x1a45dfa3) return null;
        const sz = ebmlSize(buf, p + id.len);
        if (!sz || sz.size === null) return null;
        p += id.len + sz.len + sz.size;
    }
    for (let guard = 0; guard < 16 && p < buf.length; guard++) { // Segment 的兄弟元素
        const id = ebmlId(buf, p);
        if (!id) break;
        const sz = ebmlSize(buf, p + id.len);
        if (!sz) break;
        if (id.id === 0x18538067) { // Segment：进去找 Info
            p += id.len + sz.len;
            /* ⚠️ Segment 常写成「未知长度」（全 1 的 vint）—— 实测绝大多数 mkv/webm 都这样。
               长度未知就当作「到缓冲区尾」，绝不能因为长度读不出就放弃。 */
            const limit = sz.size === null ? buf.length : p + sz.size;
            for (let g2 = 0; g2 < 32 && p < limit; g2++) {
                const cid = ebmlId(buf, p);
                if (!cid) break;
                const csz = ebmlSize(buf, p + cid.len);
                if (!csz || csz.size === null) break;
                if (cid.id === 0x1549a966) { info = { at: p + cid.len + csz.len, size: csz.size }; break; }
                if (cid.id === 0x1f43b675) break; // 撞到 Cluster：后面不会有 Info 了
                p += cid.len + csz.len + csz.size;
            }
            break;
        }
        if (sz.size === null) break;
        p += id.len + sz.len + sz.size;
    }
    if (!info) return null;

    let timecodeScale = 1000000; // 默认 1ms（纳秒）
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
        if (id.id === 0x2ad7b1) { // TimecodeScale：无符号整数
            let v = 0;
            for (let i = 0; i < sz.size; i++) v = v * 256 + buf[body + i];
            if (v > 0) timecodeScale = v;
        } else if (id.id === 0x4489) { // Duration：4 或 8 字节浮点
            if (sz.size === 4) duration = buf.readFloatBE(body);
            else if (sz.size === 8) duration = buf.readDoubleBE(body);
        }
        q = body + sz.size;
    }
    if (!(duration > 0)) return null;
    return (duration * timecodeScale) / 1e9;
}

/**
 * 文件 → 总时长（秒）；不认识 / 读不到 → null。
 *
 * 为什么要自己读：校验「时间节点有没有超出片长」必须在**开窗之前**就知道时长，
 * 而那一刻不一定有窗口可以问 IPC（视频没在播就没有通道）。起一个探针进程去问也不行 ——
 * mpv.net 没有真无头模式（实测 `--vo=null` 照样建窗口），会白闪一个窗口还慢 0.7 秒。
 *
 * 按**文件魔数**分派（不认扩展名）：EBML 头 → Matroska；否则按 ISO-BMFF 试。
 * 其它封装（avi / wmv / flv…）会走到 ISO-BMFF 分支并安全地返回 null ——
 * 调用方据此**不拦**（保持原有行为，绝不因为「读不出时长」而挡掉播放）。
 */
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
        return null; // 权限 / 文件刚被删 / 半截文件：一律当「不知道」
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
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
 * 面板里那两个**路径**输入框在失焦时用它规整一次（票 15②）：`loadSettings` 已经在入口
 * 做过 `path.normalize`（专治 `F://video` 那种写法），但面板里改完只做了 `trim()` ——
 * 于是「改完到重启插件之间」用的还是没规整的值。
 *
 * ⚠️ 空串必须原样留着：`path.normalize('')` 会得到 `'.'`，那会指向「当前目录」。
 * ⚠️ 只在**失焦**时做，别放进 onChange：打字打一半就会被规整成 `F:.`，输入框当场变形。
 */
function normalizePathInput(v) {
    const trimmed = String(v ?? '').trim();
    return trimmed ? path.normalize(trimmed) : '';
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
 *  编辑器选区：读光标/选区在文档里的偏移
 * ------------------------------------------------------------------ */

/** 光标/选区两端的文档偏移（没选中东西时两端相同） */
const cursorRange = (editor) => ({
    from: editor.posToOffset(editor.getCursor('from')),
    to: editor.posToOffset(editor.getCursor('to')),
});

/** 单个光标位置的文档偏移 */
const cursorOffset = (editor) => editor.posToOffset(editor.getCursor());

/* ------------------------------------------------------------------ *
 *  主插件
 * ------------------------------------------------------------------ */

class MpvLinkerPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        /* 通道预留表（票 12）：spawn 到管道就绪之间约 650ms，占住通道免得两次点击撞车。
           只应该在 onload 里建一次，别在别处重新赋值（会把已占的通道放走）。 */
        this.pipeReservations = new Map();
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
            this.app.workspace.on('editor-menu', (menu, editor, info) =>
                this.buildEditorMenu(menu, editor, info)
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
                buildLinkDom(keyword, splitTimes(m[2]), (t, isKeywordClick) =>
                    this.playVideo(keyword, t, isKeywordClick)
                )
            );
            last = m.index + m[0].length;
        }

        // 只出现 "{@" 未必构成合法链接（如没闭合的 {@abc）→ 原文保持不动
        if (!frag) return;
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }

    /* -------------------------------------------------------- 播放
     *
     * time 是链接里写的时间文本（'' = 没写）；isKeywordClick 为 true 表示这一下点的是
     * **片名/括号**（整条链接），而不是某个时间点 —— 见 buildLinkDom 与 ALREADY_PLAYING_MESSAGE。
     */

    async playVideo(keyword, time, isKeywordClick = false) {
        const dir = this.settings.videoDirectory;
        const mpvPath = this.settings.mpvPath || 'mpvnet';

        /** 弹提示并放弃本次播放 */
        const fail = (msg) => void notice(msg);

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
        // let：点片名时下面会把它改成 null（= 不带 --start）
        let seconds = parseTimeToSeconds(time);
        const base = this.settings.mpvIpcBase; // loadSettings 已规整成 ≥ 0 的整数

        /*
         * 「重复播放拦截」（用户 2026-09-19 要求）：点的是**片名/括号**时，如果同名视频已经在播，
         * 就什么都不做 —— 既不跳到第一个时间点、也不从头重播，只提示一句。
         * 理由：点片名的意思是「我要看这个视频」，可它已经在放了，再动一下只会把进度弄乱。
         *
         * ⚠️ 判据是**所有在播窗口**，不是「当前窗口」：用户 2026-09-19 报告 —— 先后打开两部
         * 不同名的片子后，点**先打开**那部的片名会把它跳到第一个时间点，只有点后打开那部才会提示。
         * 根因就是当时只问了「当前窗口」（= 最后启动的那个），名字对不上就漏判了。
         *
         * ⚠️ 判据用**精确文件名**，不是关键词包含（2026-10-03 改）。走到这里 `file` 已经是
         * 唯一命中的那个文件了，问的其实是「**我要播的这个文件**是不是已经在播」；
         * 用包含判断会在关键词短的时候误判：链接写 `{@01}`、命中 `260101-a.mp4`，
         * 而另一个窗口在播 `270101-b.mp4`（关键词也含 `01`）→ 明明没在播却提示「已有同名视频正在播放」。
         * 口径与 scanMpv 判「正在播的是不是这个文件」一致（都是比 mpv 报上来的 `filename` 基名）。
         *
         * ⚠️ **不再查窗口标题**（2026-10-03 用户拍板，票 08）：标题退路只在「一条受控窗口都没在播」
         * 时才走，而那正是**冷启动**（第一次点链接）这个最常见场景 —— 等于每次冷启动先付
         * 约 0.9s 的 PowerShell，只为覆盖「从资源管理器双击打开了同名视频」这种边缘情况。
         * 代价是那种窗口不再被拦截（用户明确接受）。`mpvWindowTitle()` 本身保留：
         * `currentPlayback` / `unreadablePlaybackReason` / `captureFrame` / `insertVideo` 还在用。
         *
         * 点在某个**时间点**上（isKeywordClick = false）时**不走这条路** —— 那是「我要看这一刻」，
         * 该跳就跳（复用窗口 seek）。
         */
        /* 探一遍就够（票 07）：下面的拦截、核片长、挑空位都用这一份结果。 */
        const probed = await this.probeAll();

        if (isKeywordClick) {
            const target = path.basename(file);
            const sameNamed = playingOn(probed).some((p) => p.file === target);
            if (sameNamed) {
                notice(ALREADY_PLAYING_MESSAGE);
                return;
            }
        }

        /*
         * 「点片名 = 把这部片子打开」（用户 2026-09-20 要求）：走到这里说明同名视频**没有**在播，
         * 那就**不带 --start** 直接放 —— 播放器自己记着上次的进度（>5 分钟的片子会续播），
         * 插件不该拿链接里第一个时间点去砸它。连 --start=0 都不能带：那会把续播覆盖成从头放。
         * 点某个**时间点**（isKeywordClick = false）才带时间 —— 那是「我要看这一刻」。
         */
        if (isKeywordClick) {
            time = '';
            seconds = null;
        }

        /*
         * 「时间节点超出片长」（用户 2026-09-22 要求）：链接里的时间点是手写的，可能超过片长
         * （如 21 分钟的片子写了 55:05）。这种时候**什么都不做** —— 不开窗、也不 seek：
         * 老行为是照开照播（mpv 会跳到片尾停住），用户看到的是「点了个不存在的位置却响了」。
         *
         * 判据是**大于**（用户明确要求）：时间点正好等于总时长是允许的。
         * 时长来源见 durationOf()：优先问正在播的窗口（零成本），否则读文件头；
         * **读不到时长就不拦**（保持原行为），绝不因为「不知道片长」把播放挡掉。
         */
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
                /* 层 2：**复用也算一次交互** —— 你刚点的是这个窗口，那它就是「当前窗口」。
                   不这样做的话，点回旧窗口也换不回来，之后所有「需要知道在播什么」的动作
                   （插入视频、空白处截图）会一直认错窗口。 */
                this.currentPipe = r.pipe;
                return;
            }
            free = r.free;
        }

        new Notice(`▶ ${path.basename(file)}${time ? ' @ ' + time : ''}`, PLAY_NOTICE_MS);
        /* 先占位、再 spawn（票 12）：从这一刻到管道真的建起来约 650ms，占住之后别的点击
           就不会再挑中同一条通道。子进程 exit/error 时在下面撤销。 */
        this.reservePipe(free);
        const child = this.launchMpv(mpvPath, file, seconds, free);
        // 通道名记下来：再点同一视频时直接问这一条，不必整轮探
        this.lastLaunch = { file, at: Date.now(), pipe: free, child };
        // 新起来的窗口就是「当前窗口」（层 2）。注意它与 lastLaunch 分工不同，别合并：
        // lastLaunch 是「刚启动的那个」—— 复用窗口的重试等待要靠它；currentPipe 是「最近交互过的」。
        this.currentPipe = free;

        /* 窗口一关掉就忘掉这次启动。否则再点同一视频时，会以为「mpv 正在启动、管道还没就绪」
           而白等一整个重试窗口 —— 实测那一下就是 1.5 秒，且每点一次都慢。
           子进程的 exit 是这件事唯一可靠的信号（spawn 直接失败走 error，不会发 exit）。 */
        const forget = () => {
            if (this.lastLaunch && this.lastLaunch.child === child) this.lastLaunch = null;
            this.releasePipe(free); // 进程没了 → 通道放回池子（票 12）
        };
        child.on('exit', forget);
        child.on('error', forget);
    }

    /* ---------------- 通道预留（票 12） ----------------
     *
     * spawn 到「管道真的建起来」之间实测约 650ms 的空窗（见 reuseWindow 里的时序说明）。
     * 这段时间里再点一次链接，探到的**还是同一条空闲通道** —— 因为挑空位的规则是
     * 「第一条 ENOENT 的管道」，是**确定性**的，两次点击必然撞在一起。
     * 两个 mpv 抢同一个管道名，后者绑定失败 → 那个窗口**永远不可复用**
     * （拦截看不见它、截图读不到它、再点它的时间点还会再开一个新窗口），只能手动关掉。
     *
     * 所以 spawn 之前先「占位」：占住的通道不参与挑空位。子进程 exit/error 就撤销，
     * 另加 launchFreshMs 兜底（一次彻底失败的启动不该永久占着一条通道）。
     * ⚠️ 别与 `lastLaunch` 合并：那个是「刚启动的那个」，管复用时的重试等待；
     * 这张表只管「别撞车」。
     */
    reservePipe(pipe) {
        if (!pipe) return;
        // 没走 onload 的实例（离线测试）也兜住
        if (!this.pipeReservations) this.pipeReservations = new Map();
        this.pipeReservations.set(pipe, Date.now());
    }

    releasePipe(pipe) {
        if (pipe) this.pipeReservations?.delete(pipe);
    }

    /** 这条通道是不是「刚被我们占住、管道还没就绪」（超时自动失效，防泄漏） */
    isPipeReserved(pipe) {
        const at = this.pipeReservations?.get(pipe);
        if (at === undefined) return false;
        if (Date.now() - at > TIMING.launchFreshMs) {
            this.pipeReservations.delete(pipe);
            return false;
        }
        return true;
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
     *
     * 返回 `{ reused, pipe, free }`：`reused` 为真时 `pipe` 就是命中的那条通道 ——
     * 调用方要用它把「当前窗口」切过去（层 2：**点一下链接也算一次交互**）。
     */
    async reuseWindow(base, file, seconds, time, probed) {
        const target = path.basename(file);
        const launched =
            this.lastLaunch &&
            this.lastLaunch.file === file &&
            Date.now() - this.lastLaunch.at < TIMING.launchFreshMs
                ? this.lastLaunch
                : null;

        /* 命中了在播目标时该怎么收尾。seconds 为 null（点片名）时：窗口在播这部片子
           = 「已经在放了」，与重复播放拦截说同一句话、**不动它的进度** —— 这是拦截
           检查与探通道之间的竞态兜底（检查时还没在播、几百毫秒后窗口起来了）。
           返回 false = seek 没送达（mpv 正在退出等）→ 调用方落到开新窗口。 */
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
                    break; // 通道在、命令没送达（mpv 正在退出等）→ 落到下面开新窗口
                }
                // 窗口已被关掉（exit 回调把 lastLaunch 置空）→ 管道不会再起来，别等了
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

        line(`${NOTICE_PREFIX}「${keyword}」命中 ${hits.length} 个视频，${tail}`);
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
     * 接口参数排在**最后** —— 用户不该（也很难有意地）把自己窗口的 IPC 顶掉。
     *
     * ⚠️ `--process-instance=multi` 是**无条件、必须显式带上**的（2026-09 实测后加固）：
     * mpv.net 手册里这一项的默认值是 `single`（强制单实例，第二个进程会把文件交给
     * 已存在的实例然后自己退出）。本机用的 mpv.net-DW 在 mpvnet.conf 里把它改成了 multi
     * 所以看不出问题，但**换台电脑（尤其装原生 mpv.net、没有 mpvnet.conf 的）就会退化**：
     * 实测「已有实例在跑时，新进程 exit=0 @280ms，窗口根本开不出来」。
     * 它**不能**只放在 `if (pipeName)` 里 —— 通道全忙时同样会中招。
     */
    launchMpv(mpvPath, videoPath, seconds, pipeName) {
        /* 点**时间节点**（seconds 非空）时要带的一对参数，成对出现、别拆开：
             --start=N              跳到那一刻
             --no-resume-playback   压住播放器的「续播」

           ⚠️ 第二个是必须的（2026-09-22 实测出真因，探针 `_tmp/mpv-probe/probe-start-vs-resume.cjs`）：
           mpv.net 的 `watch-later-options` 里**含 `start`** —— 也就是说「上次看到哪」是以 `start`
           选项写进续播文件的，而续播是**在文件加载时**生效的，会把命令行 `--start` 整个顶掉。
           症状极安静：给 `--start=90`，窗口却老老实实落在 41 秒（上次的续播点），
           像「时间节点不管用了」。
           ⚠️ 决定「看不看得见」的是**这片子有没有续播存档**，跟哪个 mpv.net 构建无关：
           正常关过一次窗就一定有存档，有存档就必然中招。两个构建都实测复现（探针
           `_tmp/mpv-probe/probe-start-vs-resume.cjs`）：
               原生 mpv.net + 219 秒片（续播点 41.5s）：①41.5 ✗  ②90.0 ✓
               mpv.net-DW  + 1284 秒片（续播点 42.2s）：①42.2 ✗  ②90.0 ✓
           DW 容易漏判的原因在它 profiles.conf 里那条 auto-profile：**≤5 分钟**的片子干脆
           不记进度 ⇒ 短片没有存档 ⇒ 看起来「一切正常」；**长片（>5 分钟）+ 关过一次窗**照样中。
           别按「我这儿是好的」判断。
           `--no-resume-playback` **只影响「要不要续播」**，不影响退出时记进度（实测：带它跳到 90、
           退出后再开，仍从 91 秒续播），所以点片名的续播行为不会被它弄坏。

           点**片名/括号**（seconds === null）时两个都不带 —— 那是「把这部片子打开」，
           连 `--start=0` 都不能带：那会把播放器记的进度覆盖成从头放（用户 2026-09-20 指定）。 */
        const jumpArgs = seconds === null ? [] : [`--start=${seconds}`, '--no-resume-playback'];
        const args = [
            ...parseExtraArgs(this.settings.mpvExtraArgs),
            // 无条件带上：见上面的说明，它与「有没有空闲通道」无关
            '--process-instance=multi',
            // 接口参数排在用户附加参数**之后**（同一原则）：跳转语义不该被你自己的参数顶掉
            ...jumpArgs,
        ];

        // 带上 IPC 通道，下次点同一视频就能直接 seek 而不是再开一个窗口
        if (pipeName) {
            args.push(`--input-ipc-server=${pipePathOf(pipeName)}`);
        }

        /* ⚠️ 视频路径排在 `--` **之后**、而且是最后一项（票 14）：文件名以 `-` 开头时
           （例如 `-课程-01.mp4`），mpv 会把它当成命令行选项解析、直接报错。
           `--` 之后的一律当文件名 —— 所以上面那些选项**全都**得排在它前面。
           注意「放第一位」并不能免疫，这点在真机上确认过。 */
        args.push('--', videoPath);

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
            notice('启动 mpv.net 失败，请检查设置中的播放器路径')
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
    buildEditorMenu(menu, editor, info) {
        const hint = this.linkHint;
        /* `info.file` 是**右键那个编辑器所属的文件**（票 11）：`getActiveFile()` 在分屏、
           或右键非活动窗格时会指向**另一个**文件，附件目录与链接路径都会算错。
           `info` 可能是 MarkdownView、也可能是 MarkdownFileInfo，两者都有 `.file`。 */
        const file = info?.file ?? null;
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
                    .onClick(() => this.captureFrame(editor, hint, file))
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
     * 探一遍通道区间，返回**原始结果**（`{ pipe, now, free }[]`；通道关着 → 空数组）。
     *
     * 单独抽出来是为了「**一次点击只探一轮**」（票 07）：同一次点击里，重播拦截要看
     * 「哪些窗口在播」、`durationOf` 要问时长、`reuseWindow` 要挑空位 —— 以前各探一遍，
     * 于是点一下要跑两轮 `probeRange`（每轮 8 条并行连接，最坏各一个 ipcTimeout）。
     */
    async probeAll() {
        const base = this.settings.mpvIpcBase;
        return base > 0 ? probeRange(base) : [];
    }

    /**
     * 此刻**所有**在播的受控窗口（没开控制通道 / 没在播 → 空数组）。
     * 8 条通道并行问，最坏耗时就是一个 ipcTimeout。
     *
     * `probed` 是调用方已经探好的结果（省掉这一轮，见 probeAll）。
     */
    async playingWindows(probed) {
        return playingOn(probed || (await this.probeAll()));
    }

    /**
     * 「正在播这个关键词所指视频」的那个窗口（没有 → null）。**层 1 的核心。**
     *
     * 它**不问「当前窗口是谁」**，而是拿关键词去**所有在播窗口**里找。
     * 理由：右键落在链接上时，链接本身已经说清用户指的是哪部片子 —— 再去猜「他现在看着哪个窗口」
     * 只会猜错（用户 2026-09-19 报告：先后打开两部片子后，先打开的那部会失去截图 / 插入时间节点
     * 的能力，根因就是旧实现只认「最后启动的那个窗口」）。
     *
     * 「同名」沿用全插件口径 —— 关键词是**包含**关系、不是相等。
     * 多个窗口都命中时优先「最近交互过的那个」（currentPipe），保证结果稳定可预期。
     */
    async playingForKeyword(keyword) {
        const hit = (await this.playingWindows()).filter((p) => keywordOf(p.file).includes(keyword));
        if (!hit.length) return null;
        return hit.find((p) => p.pipe === this.currentPipe) || hit[0];
    }

    /**
     * 当前正在播放的 mpv.net → { pipe, file, path, seconds }；读不到 → null。
     *
     * 两步：先问通道区间（能同时拿到文件名、完整路径与**播放进度**），一无所获时退一步看
     * 窗口标题（只有文件名，`seconds` 为 null —— 见 mpvWindowTitle 的说明）。
     * 第二步是必要的：从资源管理器双击打开的视频不在通道区间里，用户会以为「mpv 明明开着」。
     *
     * 多个窗口同时在播时，优先取「**最近交互过的**那个」（`currentPipe`：启动新窗口、或复用
     * 已有窗口都会更新它 —— 层 2）。IPC 不会告诉我们哪个窗口在前台，Windows 又没有免 P/Invoke
     * 的前台窗口查询（见 DEVELOPMENT 里那份分析），所以「最近交互过」是目前**最接近用户意图、
     * 且完全靠现有能力**的判据。
     *
     * ⚠️ 凡是**从链接里就能知道是哪部片子**的动作，都不要用这个函数 —— 那是层 1 的事
     * （`playingForKeyword`），别混。
     */
    async currentPlayback() {
        /* ponytail：复用 playingWindows()（它已含「通道关着 → 空数组」这一层），
           省掉这里重复的「探通道 + 过滤」；行为不变 —— 空数组照样落到下面的标题退路。 */
        const playing = await this.playingWindows();
        if (playing.length) {
            // 优先「最近交互过的那个」；它可能已经被关掉 → 自然落回编号最小的那条
            const recent = playing.find((p) => this.currentPipe && p.pipe === this.currentPipe);
            return recent || playing[0];
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
    async unreadablePlaybackReason(noPlaybackMessage, titled = undefined) {
        if (this.settings.mpvIpcBase <= 0) return NO_IPC_MESSAGE;
        /* `titled` 传 `null` = 调用方刚查过、结果就是「没有窗口标题」，别再问一遍（2026-10-03）：
           这条查询实测约 0.9s，而调用方（playingOrNotify / captureFrame）都是在
           `currentPlayback()` 返回 null 之后才走到这里 —— 那已经包含了「标题也是空」这个结论。 */
        const t = titled === undefined ? await mpvWindowTitle() : titled;
        if (t) return WINDOW_NOT_CAPTURED_MESSAGE;
        return noPlaybackMessage;
    }

    /** 取当前播放的 mpv.net；取不到就给出提示（并说明为什么读不到） */
    async playingOrNotify() {
        const playing = await this.currentPlayback();
        if (playing) return playing;

        // currentPlayback 返回 null ⇒ 既无受控窗口、也无任何窗口标题 → 标题不必再问一遍
        notice(await this.unreadablePlaybackReason(NO_MPV_MESSAGE, null));
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
            if (at) return { link: at, timeIndex: hint.timeIndex, fromHint: true };
        }

        // 2. 其余情况看光标/选区碰到了谁（源码模式，以及实时预览里链接还没被替换时）
        const sel = cursorRange(editor);
        const link = links.find((l) => touches(l, sel));
        if (!link) return null;

        // 右键会选中点到的那个词，所以落在哪个时间点上是可以算出来的
        const ranges = timeRangesAt(link.from, link.keyword, link.times);
        return { link, timeIndex: timeIndexAt(ranges, sel), fromHint: false };
    }

    /**
     * 光标/选区是否**落在链接内部**（两侧边界都不算）—— 「我正指着这条链接」这个问题的判据。
     *
     * 与渲染层那个闭区间 `touches` 是两回事，别合并：`touches` 决定要不要把 `{@...}` 显示成原文，
     * 用户明确要求**贴着边界也保留原文**（方便接着改）；而这里问的是「有没有指到链接」，
     * 光标停在 `}` 后面时用户多半是想接着往下写。
     * 判据用开区间：`link.from < sel.to && sel.from < link.to` —— 端点两侧各自退开一格都算「不在」。
     */
    cursorInsideLink(editor, link) {
        const sel = cursorRange(editor);
        return link.from < sel.to && sel.from < link.to;
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
        const at = cursorOffset(editor);
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
            return notice(LINK_EXISTS_MESSAGE);
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
        const link = this.resolveLink(editor, hint);

        /*
         * 层 1：右键落在链接上时，**按这条链接的片子去找它的窗口**（playingForKeyword），
         * 不要问「当前窗口是谁」。否则在看后开的那部时，没法给先开的那部补时间点 ——
         * 要么报「名称不匹配」，要么把进度补错了对象（用户 2026-09-19 报告的就是前一种）。
         * 那部片子没在播（找不到窗口）→ 落回原来的「当前窗口」逻辑，名称不匹配的提示原样保留。
         */
        let playing = link ? await this.playingForKeyword(link.keyword) : null;
        if (!playing) playing = await this.playingOrNotify();
        if (!playing) return;

        // 退路（窗口标题）只给得出文件名，给不出进度 —— 不编一个 0 秒去骗用户
        if (playing.seconds === null) {
            return notice(WINDOW_NOT_CAPTURED_MESSAGE);
        }

        const name = keywordOf(playing.file);
        const time = formatTime(playing.seconds);

        if (link) {
            // 关键词要对得上在播的视频才肯追加：否则用户以为在给「这条」补时间，其实补错了对象
            // （只有上面落回「当前窗口」的那条路才可能走到这里）
            if (!name.includes(link.keyword)) {
                return notice('该链接与mpv.net正在播放的视频名称不匹配！');
            }
            if (link.times.includes(time)) {
                return notice(`这条链接里已经有「${time}」了`, PLAY_NOTICE_MS);
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
        const at = cursorOffset(editor);
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
     *   · 指到关键词/括号上 → 整条 {@...} 删掉
     *   · 指到某个时间点上 → 只删那一个（删到最后一个时顺手去掉 `&`，回到 {@关键词}）
     *
     * **必须真的指到那条链接才动手**（用户 2026-09-19 要求）：
     *   · 右键点是点在**渲染出来的链接**上（hint 命中）→ 算指到；
     *   · 否则看光标/选区 —— 只有落在链接**内部**才算，**贴在两端（尤其紧贴在 `}` 后面）不算**。
     *     紧贴 `}` 时用户多半是想接着往下写，而不是要删掉上一条链接；空白处同理。
     *   这两种情况都**什么都不做**，只提示 `DELETE_HINT_MESSAGE`（用户要求文案统一）。
     *
     * **不读播放器**：删除纯粹是文档操作，mpv.net 开不开都该能用 —— 所以它不走
     * playingOrNotify()，「未获取到mpv.net视频」那句提示对删除是无意义的。
     *
     * 只删链接本身，不动紧邻的空格（多留一个空格是可见的、但可预料；悄悄吃掉用户打的空格更糟）。
     */
    deleteLinkOrTime(editor, hint) {
        /** 没指到链接 → 什么都不做，只说清该怎么操作 */
        const miss = () => notice(DELETE_HINT_MESSAGE);

        const target = this.resolveTarget(editor, hint);
        if (!target) return miss();
        // hint 那条路已经在 resolveTarget 里按文档校验过区间，命中即「确实点在链接上」
        if (!target.fromHint && !this.cursorInsideLink(editor, target.link)) return miss();

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
        notice(
            '视频名里有 { } & | 之类的保留字符，没法写成链接 → ' +
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
        if (!target) return notice('请在mpv.net视频链接上右键选择该命令！');

        const dir = this.settings.videoDirectory;
        if (!dir) return notice('请先在设置里填写「视频文件目录」');

        const keyword = target.link.keyword;
        const { dirOk, hits } = await this.findVideoFiles(dir, keyword);
        if (!dirOk) return notice(`视频目录不存在或无法读取 → ${dir}`);
        if (!hits.length) return notice('指定目录下未匹配到相关视频！');
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
        child.on('error', () => notice('打开系统文件管理器失败'));
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
    async captureFrame(editor, hint, file = null) {
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
                    return notice(WINDOW_NOT_CAPTURED_MESSAGE);
                }
                return notice(SNAP_TIME_ONLY_MESSAGE);
            }

            /* ⚠️ 「另起一行」挪到**截图成功之后**了（2026-10-03 票 09）：以前在这里就插空行、
               挪光标，而截图有七条失败出口（目录没填 / 读不到 / 没找到 / 命中多个 / 播放器路径
               不存在 / 超时 / 没出图），每一条都会在用户笔记里留下一个空行 —— 文档不该被一次
               失败的截图改动。现在这件事交给 captureVideo 的 `ownLine`，它在**拿到图之后**做。 */
            return this.captureVideo(editor, keywordOf(playing.file), playing.seconds, playing.path, false, {
                ownLine: true,
                sourceFile: file,
            });
        }

        // ② 时间节点上：截那一刻（时间点是手写的，所以要核片长 —— checkRange = true）
        if (target) {
            const { link, timeIndex } = target;
            return this.captureVideo(
                editor,
                link.keyword,
                parseTimeToSeconds(link.times[timeIndex]),
                null,
                true,
                { sourceFile: file }
            );
        }

        // ③ 空白处：先问 mpv.net 此刻在播什么、播到第几秒，再照着重截一帧
        const playing = await this.currentPlayback();
        if (!playing) {
            // 与 playingOrNotify 同一套分情况，只有「真没在播」那一句换成截图的口径
            // （同样把「标题已经查过、是空的」传下去，省掉第二次约 0.9s 的 PowerShell）
            return notice(await this.unreadablePlaybackReason(SNAP_NO_PLAYING_MESSAGE, null));
        }
        // 退路（窗口标题）只给得出文件名、给不出进度，这条路上用不了 —— 如实提示，不编一个 0 秒
        if (!playing.pipe || playing.seconds === null || !playing.path) {
            return notice(WINDOW_NOT_CAPTURED_MESSAGE);
        }

        // mpv 的 path 属性直接就是完整本地路径，不必像 VLC 那样再去播放列表里对号
        return this.captureVideo(editor, keywordOf(playing.path), playing.seconds, playing.path, false, {
            sourceFile: file,
        });
    }

    /**
     * 「与这个关键词同名的、此刻正在播的视频」——没有 → null。
     *
     * 「同名」的判据沿用链接匹配那套（关键词是**包含**关系，不相等）：用户的视频按
     * `YYMMDD-标题.mp4` 命名，链接里写的是其中一段，所以用 includes 才对得上。
     *
     * **层 1**：拿关键词去**所有在播窗口**里找（`playingForKeyword`），而不是问「当前窗口是谁」——
     * 否则在看后开的那部片子时，给先开的那部片子截图会得到 null（或截错片子）。
     *
     * 只认**能出图**的窗口（读得到秒数、且拿得到完整路径）：退路（窗口标题）给不出进度，
     * 截不了「此刻」那一帧，那种情况按「没有同名在播视频」处理，走原来的提示。
     */
    async matchingPlaying(keyword) {
        const playing = await this.playingForKeyword(keyword);
        if (!playing || playing.seconds === null || !playing.path) return null;
        return { file: playing.file, seconds: playing.seconds, path: playing.path };
    }

    /**
     * 某个视频文件的总时长（秒）；**读不到就给 null**（调用方据此不拦，保持原行为）。
     *
     * 两步、先便宜后贵：
     *   ① 已经有**受控窗口**在播这个文件 → 直接问它。`duration` 与其它探针属性同批发出，
     *      不增加往返，所以这一路是零成本、而且读到的就是播放器眼里的真实时长；
     *   ② 没有 → 读容器头（`durationFromFile`，只读几十 KB，不起进程、不闪窗口）。
     *
     * ⚠️ ② 是**必须**的：点时间节点那一刻，视频往往还没在播（没有通道可问）；
     * 而「起一个探针进程去问时长」行不通 —— mpv.net 没有真无头模式（实测 `--vo=null`
     * 照样建窗口），会白闪一个窗口、还慢 0.7 秒。
     *
     * 「同名」沿用全插件口径：比的是**文件名**（mpv 的 `filename` 就是基名）。
     */
    async durationOf(file, probed) {
        const target = path.basename(file);
        for (const p of await this.playingWindows(probed)) {
            if (p.file === target && typeof p.duration === 'number' && p.duration > 0) {
                return p.duration;
            }
        }
        return durationFromFile(file);
    }

    /**
     * 找到视频 → 独立进程截一帧 → 落盘 → 插进笔记。
     * videoPath 非空时直接用（空白处那条路已经从 IPC 问到了完整路径）。
     *
     * `checkRange`：`seconds` 是**链接里手写的**时间节点时传 true —— 要先核一下有没有超出片长
     * （用户 2026-09-22 要求，与「点时间节点播放」同一套判据）。其它几条入口的 seconds
     * 都是从正在播的窗口读来的实时进度，天然有效，不用核（核了反而危险：
     * 播到片尾时 `time-pos` 会略微超过 `duration`，那会误拦）。
     */
    async captureVideo(
        editor,
        keyword,
        seconds,
        videoPath,
        checkRange = false,
        { ownLine = false, sourceFile = null } = {}
    ) {
        const mpvPath = this.settings.mpvPath || 'mpvnet';

        let video = videoPath;
        if (!video) {
            const dir = this.settings.videoDirectory;
            if (!dir) return notice('请先在设置里填写「视频文件目录」');
            const { dirOk, hits } = await this.findVideoFiles(dir, keyword);
            if (!dirOk) return notice(`视频目录不存在或无法读取 → ${dir}`);
            if (!hits.length) {
                return notice(`未找到文件名包含「${keyword}」的视频`);
            }
            // 命中多个时不猜（与播放同一套提示），用户把关键词写精确了再点一次
            if (hits.length > 1) return this.notifyAmbiguous(keyword, hits, '未截图');
            video = hits[0];
        }

        // 与 playVideo 同一道守卫：路径是绝对路径却不存在时先明说，别让 spawn 的失败无声无息
        if (/[\\/]/.test(mpvPath) && !(await fileExists(mpvPath))) {
            return notice(`找不到 mpv.net 可执行文件 → ${mpvPath}`);
        }

        /* 链接里手写的时间节点可能超出片长：超了就什么都不做。
           不核的话会**静默截到最后一帧** —— 看着像「截到了那个时间点」，其实不是。 */
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
            if (!markdown) return; // 写不进去（已经提示过了）→ 不碰文档

            /* 图已经进仓库了，**这时候才动用户的文档**（票 09：动文档必须是最后一步 ——
               前面任何一条失败出口都不许碰笔记）。
               `ownLine`：先另起一行再插（片名那条路要的排版）。
               位置**此刻**重新取光标行：不能提前算好，否则截图这一两秒里用户挪了光标就对不上。 */
            if (ownLine) {
                /* 为什么不是「插到光标处」：光标这会儿紧贴 `}` 后面，直接插会把图片贴在那条链接
                   屁股后面（`{@…&01:16}![](…)`），既不是用户要的排版，也让图片挤在链接行里。

                   分行手法沿用同作者的 hyc-editing 插件：取当前行文本 + 换行符，把**整行**
                   替换掉 —— 等价于在行尾敲一次回车，光标自然落到新空行行首。
                   这里不写死 `\r\n`：编辑器自己认 `\n`，而 CRLF 在 Obsidian 里会多出一个
                   看不见的回车符。 */
                const line = editor.getCursor().line;
                const lineText = editor.getLine(line);
                editor.replaceRange(lineText + '\n', { line, ch: 0 }, { line, ch: lineText.length });
                editor.setCursor({ line: line + 1, ch: 0 });
            }
            this.insertSnapshotLink(editor, markdown);
        } catch (err) {
            /* 出图之后的这一步也会失败，而且失败得很安静（2026-10-03 补）：
               `getAvailablePathForAttachment` / `vault.createBinary` 会因为目录被删、同名
               竞争、权限不足而抛；异常一路穿过 finally，变成菜单回调里的**未处理 rejection**
               —— 用户看到的就是「点了没反应」，连失败都没人告诉他。
               这里只负责「说话」：不重试、也不回滚（临时目录照旧由 finally 清掉）。 */
            console.error('[MPV Linker] 截图写盘失败：', err);
            notice(SNAP_SAVE_FAILED_MESSAGE);
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
     * **只起一个进程**（2026-09-22 改）：缩放与否、缩到多少，都由 `snapshotScaleFilter()`
     * 生成的相对表达式交给 mpv 自己算 —— 不必「先截一枪量出源尺寸、再决定要不要补第二枪」。
     * 好处有两个：截图时只闪一次窗口（老做法最多两次），以及缩放在**同一帧**上完成，
     * 不会出现两枪之间画面位置/解码状态不一致的问题。
     */
    async captureFrameAt(videoPath, seconds) {
        const mpvPath = this.settings.mpvPath || 'mpvnet';
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

    /**
     * 起一次独立的 mpv.net：跳到 seconds、把帧写成图片、然后收掉它。
     * 返回编号最小的那张图 { bytes, width, height }（没出图 → null）。
     * `filter` 是 `--vf` 的值（null = 不挂滤镜，按原始分辨率）。
     *
     * 参数全是 mpv 自带的命令行选项，没有一处是本插件发明的：
     *   --vo-image-outdir=<目录>  输出目录 ⚠️ **必须排在 --vo=image 之前**（见下）
     *   --vo=image                image 视频输出负责把帧写成图片
     *   --vo-image-format / --vo-image-jpeg-quality   格式与画质
     *   --vf=<表达式>              缩放（相对表达式，只给宽，高按比例；见 snapshotScaleFilter）
     *   --start=<秒> / --frames=1  定位到目标秒、只要一帧
     *   --no-audio                不占音频设备
     *   --no-config               不读用户配置（否则断点续播 / 循环 / 滤镜都会渗进来）
     *   --window-minimized=yes    把窗口收起来（mpv.net 没有真正的无头模式，见文件头）
     *
     * ⚠️ 四条实测出来的硬约束，别凭推理改 —— 每条的理由与数据都在下面 args 里对应那几行：
     *  1. `--vo-image-*` 整族必须排在 `--vo=image` 之前；另加一道保险：子进程 cwd 也设成输出目录。
     *  2. `--frames=1` 不保证生效（它不是 property 开关）→ 只认编号最小的那张图（见 firstImageName）。
     *  3. 它不会好好退出（0xC0000005 秒退 / 挂住不退出），但**都在出图之后** →
     *     收尾一律「等图完整就自己 kill」，不依赖退出码（拿退出码判成败会误报）。
     *  4. `--start` 必须配 `--no-resume-playback`，否则续播会顶掉起点（截错帧）并删掉用户的存档；
     *     `--no-config` 挡不住它。
     */
    async runImageOutput(mpvPath, videoPath, seconds, dir, filter) {
        const args = [
            /* ⚠️ 必须无条件带上（2026-09-19 在原生 mpv.net 上暴雷后加固的）：
               mpv.net 的 `process-instance` 默认是 `single` —— 只要这台机器上还有**别的 mpv.net
               在跑**（比如用户正在看的那个窗口），本进程就会把文件「交接」过去、自己立刻退出：
               实测 exit=0 @280ms、一张图都不写；更糟的是**用户正在看的窗口会被换成这里的视频**。
               mpv.net-DW 的 mpvnet.conf 里写着 multi，所以在这台机器上一直看不出问题 ——
               换到原生 mpv.net（没有 mpvnet.conf）就必然踩。命令行能压过配置，实测有效。 */
            '--process-instance=multi',
            /* ⚠️ `--vo-image-*` 这一族**全部**必须排在 `--vo=image` 之前（2026-09-22 实测）：
               mpv.net-DW 会**静默忽略**排在 `--vo=image` 之后的 vo-image 选项 —— 不报错、不提示，
               参数就是没生效。症状：质量设 1 与设 100 截出来的图**逐字节同大小**（都在用 mpv 的
               默认 90）、`--vo-image-format=png` 照样出 jpg。
               ⚠️ 只有 **DW 构建**忽略，原生 mpv.net 7.1.2.0 不忽略 —— 「换台机器就测不出」会骗人，
               所以一律按最严的来：三条全放前面。详见 docs/DEVELOPMENT.md §3.6。 */
            `--vo-image-outdir=${dir}`,
            `--vo-image-format=${SNAP_FORMAT}`,
            `--vo-image-jpeg-quality=${resolveSnapQuality(this.settings.snapshotQuality)}`,
            '--vo=image',
            ...(filter ? [`--vf=${filter}`] : []),
            `--start=${seconds}`,
            /* ⚠️ 与 `--start` **成对**出现，别拆开（2026-09-22 实测，与 launchMpv 里同一对）：
               mpv 的 `watch-later-options` 里含 `start`，续播是在**文件加载**时把存档里的
               `start` 再赋一次 —— 晚于命令行，会把 `--start=N` 整个顶掉。对截图这条路
               症状特别毒：截到的不是链接里那个时刻，而是**上次退出的位置**那一帧；
               同一支片子截两个不同时间点会得到**同一张图**（实测起点 100s 出的图与
               「无存档基准」不同、且两次跑还不一样）。
               ⚠️ 更隐蔽的一半：走完这条路 mpv 会认为「这片子看完了」，顺手把用户的
               **watch_later 存档删掉** —— 实测造好 3 个存档条目，截一张图后剩 **0 个**；
               带上本 flag 后仍是 3 个（探针 `_tmp/mpv-probe/probe-shot-archive-sideeffect.cjs`）。
               加上它之后，3 个起点的出图与「空存档基准」**逐字节一致**。
               ⚠️ 别指望 `--no-config` 能挡住续播：它只是「不读用户配置文件」，
               **管不着 watch_later**（实测 `--start=100 --no-config` 照样续播到 42.2s）。
               截图永远要「就是这一秒」，任何时候都不需要续播，所以无条件带上。 */
            '--no-resume-playback',
            '--frames=1',
            '--no-audio',
            '--no-config',
            '--window-minimized=yes',
        ];

        // 视频路径同样排在 `--` 之后（票 14）：文件名以 `-` 开头时不会被当成选项。
        // ⚠️ 上面那一族 `--vo-image-*` 必须排在 `--vo=image` 之前（另一条承重顺序），别被打乱。
        args.push('--', videoPath);

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

        await new Promise((resolve) => {
            let settled = false;
            let timer = null;
            let poll = null;
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
            /* ⚠️ 这里必须再核一次完整性（2026-10-03 补）：轮询那条路会等到「大小稳定 +
               结尾 EOI」才收手，但**超时**那条是直接砍进程的 —— 那一瞬间 mpv 可能正写到
               一半。而 jpegSize 解析的是文件开头的尺寸段，对截断文件照样给得出宽高，
               于是半张图会一路走完 saveSnapshot 写进仓库（还插了链接、没有任何提示）。
               判据用与轮询同一把尺（isCompleteJpeg）：不完整就当作「没有出图」。 */
            if (!isCompleteJpeg(bytes)) return null;
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
     *
     * ⚠️ 它**只写文件、把要插的那段 markdown 返回出去，不碰编辑器**（2026-10-03 票 09 拆的）。
     * 以前写文件与插链接挤在一起，于是「插空行 + 挪光标」只能发生在截图**之前** ——
     * 而截图有七条失败出口，每一条都会在用户笔记里留下一个空行。
     *
     * `sourceFile`：右键那个编辑器所属的文件（票 11）。`getActiveFile()` 在分屏、
     * 或右键非活动窗格时会指向**另一个**文件，附件目录与链接路径都会算错 ——
     * `info.file` 才是对的，`getActiveFile()` 现在只作兜底。
     */
    async writeSnapshot(bytes, keyword, seconds, sourceFile = null) {
        const fm = this.app.fileManager;
        const note = sourceFile || this.app.workspace.getActiveFile();
        const sourcePath = note ? note.path : '';
        const name = snapshotFileName(keyword, seconds, '.' + SNAP_FORMAT);

        const folder = this.settings.snapshotFolder;
        let dest;
        if (folder) {
            // 目录必须是仓库里真实存在的文件夹：仓库外的图片插进笔记显示不出来（见设置面板）
            if (!(this.app.vault.getAbstractFileByPath(normalizePath(folder)) instanceof TFolder)) {
                notice(`${SNAP_FOLDER_MISSING_MESSAGE} → ${folder}`);
                /* ⚠️ 必须返回 null（不是把 notice 的返回值丢出去）：调用方拿到 null 就跳过
                   插入 —— 否则会把一个 Notice 对象当 markdown 插进笔记。 */
                return null;
            }
            dest = this.availablePathIn(folder, name);
        } else {
            dest = await fm.getAvailablePathForAttachment(name, sourcePath);
        }

        const file = await this.app.vault.createBinary(dest, bytes);
        return `!${fm.generateMarkdownLink(file, sourcePath)}`;
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
        const at = cursorOffset(editor);
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
        if (!Object.prototype.hasOwnProperty.call(SNAP_PX_TARGET, s.snapshotResolution)) {
            s.snapshotResolution = DEFAULT_SETTINGS.snapshotResolution;
        }
        // 保存目录收成仓库相对路径（空 = 用附件默认位置），收法与设置面板共用 cleanFolderPath
        s.snapshotFolder = cleanFolderPath(s.snapshotFolder);

        // 截图质量：收成 20~100 的整数；0/非法值 → 默认 90，低于 20 的旧值抬到 20
        s.snapshotQuality = clampQuality(s.snapshotQuality);

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

        /* 设置项统一走这两个小工厂：名称 + 描述 + 一个控件，改完即存。
           第一个参数是挂载位置 —— 高级选项那一块要挂进折叠容器，不能都挂在 containerEl 上。 */
        /* `normalize`（可选，票 15②）：**只给路径类的两个框**用 —— 失焦时把值规整一次。
           放在失焦而不是 onChange：打字打一半就被规整的话，输入框会当场变形。 */
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

        /** 下拉框。options 形如 { 值: 显示文案 }，回写的是「值」 */
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
            normalizePathInput // 失焦时规整（票 15②）
        );

        field(
            containerEl,
            'mpv.net 播放器路径',
            '播放器在哪。默认值能用就别改；便携版填 mpvnet.exe 的完整路径。',
            'mpvnet',
            settings.mpvPath,
            (v) => (settings.mpvPath = v.trim()),
            normalizePathInput // 失焦时规整（票 15②）
        );

        field(
            containerEl,
            '视频扩展名',
            '哪些文件算视频。逗号分隔，一般不用改。',
            '.mp4,.mkv,.avi',
            settings.videoExtensions.join(','),
            (v) => (settings.videoExtensions = normalizeExtensions(v.split(',')))
        );

        containerEl.createEl('h3', { text: '插入视频截图' });

        dropdown(
            containerEl,
            '截图分辨率＞2K时缩放操作(2560x1440)',
            '视频太大时先缩小再截图，省地方。本来就小的视频保持原样，绝不会被放大。',
            SNAP_RESOLUTION_OPTIONS,
            settings.snapshotResolution,
            (v) => (settings.snapshotResolution = v)
        );

        /* 截图质量：Obsidian 自带的滑块 + 一个「重置」按钮（用户 2026-09-22 指定）。
           范围 **20~100**（20 是下限 —— 质量给到 1 那种档位糊得没有实用性，已从界面上取消）；
           100 = jpg 质量拉满（最接近无损、体积最大）；其余数值就是质量参数。
           右边那个是 Obsidian 原生的 ExtraButton（不是自己搭的），图标用它内置的 `rotate-ccw`
           —— Obsidian 自己给这个图标起的别名就叫 `reset`（它的图标别名表里 `reset: "rotate-ccw"`），
           所以这就是「Obsidian 原生的重置图标」。点一下把滑块与设置一起拉回默认 90。 */
        const qualitySetting = new Setting(containerEl)
            .setName('截图质量')
            .setDesc(
                `20~100，数值越大越清晰、图片也越大。默认 ${DEFAULT_SETTINGS.snapshotQuality}，` +
                    '右侧按钮可一键恢复。'
            );

        // 留一个滑块句柄给「重置」按钮：按钮要能把滑块的**外观**也一起拉回去，光改设置是不够的
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

        /* 保存目录：输入框 + 仓库目录联想，与「文件与链接 → 新附件的默认位置」同一个行为。
           输入当场规整（cleanFolderPath），保证存下去的就是保存时拿去查的那个写法。 */
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

        /* 高级选项：**默认折叠**、放在面板最底部 —— 普通用户不用碰（用户 2026-09-23 要求）。
           PluginSettingTab 没有现成的折叠控件，用原生 <details> 自己搭；
           不写 open 属性就是「默认收起」，外观见 styles.css 的 .mpv-linker-advanced。 */
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
    ALREADY_PLAYING_MESSAGE,
    DELETE_HINT_MESSAGE,
    FILM_ICON,
    CLOCK_ICON,
    SCISSORS_ICON,
    CAMERA_ICON,
    FOLDER_ICON,
    SNAP_ROOT,
    SNAP_QUALITY,
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
    jpegSize,
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
