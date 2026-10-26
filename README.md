# MPV Linker

**Click a link in your notes and the video starts at exactly that second.**

> An Obsidian plugin that opens a local video in [mpv.net](https://github.com/mpvnet-player/mpv.net)
> at a timestamp written in your note. Windows only.

**English** · [中文](#中文说明)

---

## Quick start

1. Install **mpv.net** and note the full path to `mpvnet.exe`
2. Put `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/mpv-linker/`
3. In Obsidian: Settings → Community plugins → enable **MPV Linker**
4. Fill in **Video folder** and **mpv.net path**
5. Write `{@260414&07:23}` in a note and click it

Details below.

---

## Installation

### 1. Install the player

mpv.net is a free Windows player. Pick either build — **it makes no difference to this plugin**:

- Official: https://github.com/mpvnet-player/mpv.net
- DW build: https://github.com/diana7127/mpv.net-DW (prettier UI, thumbnails, localized menus; the one the author uses)

Open the page → **Releases** → download the latest installer → install.

**Note the full path to `mpvnet.exe`**, e.g. `D:\Tools\mpv.net\mpvnet.exe`.
If you ticked "add to PATH" during installation you can simply enter `mpvnet`; if unsure, use the full path.

### 2. Install the plugin

1. Open your vault folder and go to `.obsidian\plugins\`
   (can't see `.obsidian`? It's hidden — enable "Hidden items" in Explorer)
2. Create a folder named **exactly** `mpv-linker`
3. Put `main.js`, `manifest.json` and `styles.css` inside it
4. Open Obsidian → Settings → Community plugins → click **Reload** → enable **MPV Linker**

### 3. Configure

Click the gear next to "MPV Linker" under Community plugins.

**Required:**

| Setting | What to enter | Example |
| --- | --- | --- |
| **Video folder** | Folder containing your videos (absolute path). Subfolders are searched too | `F:\video` |
| **mpv.net path** | The path from step 1; or `mpvnet` if it's on PATH | `D:\Tools\mpv.net\mpvnet.exe` |

**Screenshots (skip if you don't need them):**

| Setting | What to enter | Default |
| --- | --- | --- |
| Downscale when above 2K (2560x1440) | Shrinks large videos before saving a frame. Small videos are never upscaled | Off |
| Screenshot quality | 20–100, higher is sharper and larger; the button on the right restores the default | 90 |
| Screenshot folder | Empty = Obsidian's attachment folder; or any folder inside the vault (with autocomplete) | Empty |

**Video extensions**: which files count as videos, comma separated. Usually leave it as is.

There is also a collapsed **Advanced** section: extra player arguments (e.g. `--ontop` to keep the window on top) and the window-reuse pipe base (`0` disables reuse).

---

## Usage

### Write a link

Type one of these in a note; switch to preview to see a clickable link:

| You write | What happens |
| --- | --- |
| `{@260414}` | Plays the video whose filename **contains** `260414`, from the start |
| `{@260414&07:23}` | Starts at 07:23 |
| `{@260414&07:23\|12:28}` | Two independent links, each jumps to its own time |

- **Time** accepts `mm:ss` (`07:23`) and `h:mm:ss` (`1:02:03`).
- **Matching is "contains"**: for `260414-title.mp4`, `260414` — or any fragment of the name — is enough.
- **Several matches**: the plugin never guesses. A notice lists the matched files; make the keyword more specific and click again.
- **Clicking the title** (no timestamp) means "open this video". If it is already playing in a window the plugin opened, you only get a notice — your progress is untouched.
- **While the cursor touches a link**, the raw `{@...}` text is shown so you can edit it.

### Right-click menu

In the **editor view**, right-click a note → **MPV Linker**:

| Item | What it does |
| --- | --- |
| **Insert video** | Reads the playing video's name and writes `{@name}` |
| **Insert timestamp** | Reads the current position and writes `{@name&time}`; on an existing link it appends to that link |
| **Delete link or timestamp** | Deletes the whole link, or only the timestamp you clicked |
| **Insert screenshot** | Captures the current frame and inserts it into the note |
| **Show in file explorer** | Opens the video's folder and selects the file |

**Smoothest way to use "Insert timestamp"**: click a link to start playback, pause where you want to take a note, come back and right-click → Insert timestamp.

### Insert a screenshot

| You right-click on | Result |
| --- | --- |
| **A timestamp** (e.g. `07:23`) | Captures that exact frame — **the video does not need to be playing**; the image goes on the **line below that link** |
| **A title / bracket**, and the same video is playing | Captures the current frame, on the **line below that link** |
| **Empty space in the note** | Captures the frame from the most recent player window, inserted **at the cursor** |
| **A title / bracket**, but that video isn't playing | The note is left untouched; you get a notice asking you to use a timestamp |

> Taking a screenshot **does not interrupt the video you're watching**, but a window **flashes briefly** (see Limitations).

---

## FAQ

**"No video found containing …"**
Check the **Video folder**, whether the file is inside it (subfolders included), and that its extension is listed under **Video extensions**.

**"mpv.net executable not found"**
The **mpv.net path** is wrong. Use the full path to `mpvnet.exe`, including `.exe`.

**The player is running but the plugin can't read playback progress**
Only windows opened **through a note link** are readable. A window opened by double-clicking in Explorer has no connection to the plugin. Click the matching link in a note first, then use the right-click menu.

**Videos opened by double-click sometimes resume, sometimes restart**
That is mpv.net's own rule, not the plugin: videos **longer than 5 minutes** remember the position, **5 minutes or shorter** do not.

**What if the timestamp is beyond the video's length?**
No window is opened; you get a notice. Exactly equal to the length is not "beyond". If the length can't be read for an unusual format, the plugin plays as before.

---

## Limitations

- **Windows desktop only** (mpv.net has no other platform build; mobile Obsidian won't work)
- **A window flashes when taking a screenshot** — mpv.net has no true background mode
- **Windows opened by double-clicking expose no progress**, so "Insert timestamp" and "screenshot from empty space" don't work on them; use note links instead
- The right-click menu exists only in the **editor view**, not in reading mode

## License

[MIT](LICENSE) — do whatever you want, just keep the copyright notice.

## Author

nnq7

---

## 中文说明

**在笔记里点一下，视频就从你写的那一刻开始播。**

### 快速开始

1. 装 **mpv.net**，记住 `mpvnet.exe` 的完整路径
2. 把 `main.js`、`manifest.json`、`styles.css` 放进 `.obsidian/plugins/mpv-linker/`
3. 打开 Obsidian → 设置 → 第三方插件 → 启用 **MPV Linker**
4. 设置里填「视频文件目录」和「mpv.net 播放器路径」
5. 笔记里写 `{@260414&07:23}`，点它

### 安装

**1. 装播放器**：mpv.net 是免费的 Windows 播放器，两个版本功能上没有区别——官方版
https://github.com/mpvnet-player/mpv.net ，或 DW 版 https://github.com/diana7127/mpv.net-DW
（美化版，自带缩略图与汉化界面，本插件作者在用）。打开页面 → 右侧 **Releases** → 下载安装。

装完记下 `mpvnet.exe` 的完整路径，例如 `D:\Tools\mpv.net\mpvnet.exe`。安装时勾了「添加到 PATH」的话，
后面设置里只写 `mpvnet` 就够了；不确定就写完整路径。

**2. 装插件**：进入仓库目录下的 `.obsidian\plugins\`（看不到就勾上「隐藏的项目」）→ 新建文件夹
**必须叫** `mpv-linker` → 把 `main.js`、`manifest.json`、`styles.css` 放进去 →
打开 Obsidian → 设置 → 第三方插件 → 点「刷新」→ 找到 **MPV Linker** → 打开开关。

**3. 填设置**（必填两项）：

| 设置项 | 填什么 | 例子 |
| --- | --- | --- |
| **视频文件目录** | 视频放在哪个文件夹，填绝对路径；子文件夹会自动一起搜索 | `F:\video` |
| **mpv.net 播放器路径** | 上面记下的路径；已加入 PATH 的可以只写 `mpvnet` | `D:\Tools\mpv.net\mpvnet.exe` |

截图相关（不截图可以不管）：**截图分辨率＞2K时缩放操作**（大视频先缩小，小视频绝不放大，默认不操作）、
**截图质量**（20~100，默认 90，右侧按钮一键恢复）、**截图保存目录位置**（留空 = Obsidian 的附件目录）。

**视频扩展名**一般不用改。底部还有个默认收起的「高级选项」：附加启动参数（如 `--ontop` 让窗口总在最前）、
复用窗口通道（填 `0` 可关掉「已在播就直接跳」）。

### 用法

**写链接**：

| 你写的 | 效果 |
| --- | --- |
| `{@260414}` | 播放文件名**包含** `260414` 的视频，从头开始 |
| `{@260414&07:23}` | 直接从 07:23 开始播 |
| `{@260414&07:23\|12:28}` | 两个时间点是两个独立链接，点哪个跳哪个 |

时间支持 `分:秒` 和 `时:分:秒`。关键词是「包含」匹配，写片名里任意一小段都行。命中多个会列出来让你写精确。
点片名（不带时间）=「把这部片子打开」，若它已在插件打开的窗口里播着，只提示一句、不打断你。
光标停在链接里或紧贴两端时，会显示回 `{@...}` 原文，方便修改。

**右键菜单**（编辑视图里对着笔记右键 → MPV Linker）：

| 菜单项 | 作用 |
| --- | --- |
| **插入视频** | 读「正在播的视频名」，自动写成 `{@视频名}` |
| **插入时间节点** | 读「现在播到第几秒」，自动写成 `{@视频名&时间}`；对着已有链接右键则追加进那条链接 |
| **删除链接或时间节点** | 整条删掉，或只删你点中的那个时间点 |
| **插入截图** | 把某一刻的画面截成图片，插进笔记 |
| **在系统资源管理器中显示** | 打开视频所在文件夹并选中它 |

**插入截图**：右键时间节点 → 截**那一刻**（不需要视频在播），图插在这条链接的**下一行**；
右键片名且同名视频在播 → 当前帧插在**下一行**；右键空白处 → 截最近那个窗口的当前帧，插在**光标处**。
截图**不会打断你正在看的视频**，但会**闪一下窗口**。

### 常见问题

- **提示「未找到文件名包含××的视频」**：检查「视频文件目录」、视频是否在该目录（含子目录）、扩展名是否在列表里。
- **提示「找不到 mpv.net 可执行文件」**：播放器路径不对，填 `mpvnet.exe` 完整路径，别漏 `.exe`。
- **播放器开着却读不到进度**：只有**通过笔记链接打开**的窗口才读得到；从文件夹双击打开的不算。先在笔记里点一下链接。
- **双击打开的视频，关掉再开有时接着播、有时从头**：这是 mpv.net 自己的规则——**超过 5 分钟**记进度，**5 分钟以内**不记。
- **时间点超过片长**：不会打开窗口，只会提示；正好等于片长不算超。

### 已知限制

- **只支持 Windows 桌面版**（mpv.net 没有其他平台版本，手机版 Obsidian 也用不了）
- **截图时会闪一下窗口**——mpv.net 没有完全后台运行的模式
- **从文件夹双击打开的窗口读不到播放进度**，所以「插入时间节点」「空白处插入截图」对它无效
- 右键菜单只在**编辑视图**里有，阅读模式没有
