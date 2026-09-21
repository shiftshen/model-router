import AppKit
import Combine
import SwiftUI

struct ModelLibraryView: View {
    // 标题栏的版本号从 bundle 读，别写死——写死过一次就变成「装的明明是新版，界面还显示旧版」。
    private var bundleVersion: String { (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?" }
    private let updateTimer = Timer.publish(every: 6 * 3600, on: .main, in: .common).autoconnect()

    @StateObject private var library = LibraryViewModel()
    @State private var editing: ManagedModel?
    @State private var renameTarget: WorkWindow?
    @State private var renameDraft = ""

    @State private var showModels = false
    @State private var didSizeWindow = false
    @State private var unmanagedDeleteTarget: UnmanagedWindow?

    // 首页回答的是「我有哪些窗口、现在能不能进去」，而不是「我有哪些模型」。
    // 模型配置是低频动作，收进「模型库」弹窗里改。
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            windowBoard
            Divider()
            statusBar
        }
        .frame(minWidth: 820, minHeight: 580)
        .sheet(isPresented: $showModels) { modelLibrary }
        .sheet(item: $renameTarget) { window in renameSheet(window) }
        .confirmationDialog("确认删除这个单模型窗口？", isPresented: Binding(
            get: { unmanagedDeleteTarget != nil },
            set: { if !$0 { unmanagedDeleteTarget = nil } }
        ), titleVisibility: .visible) {
            Button("删除，且不可恢复", role: .destructive) {
                let target = unmanagedDeleteTarget?.windowID ?? ""
                unmanagedDeleteTarget = nil
                Task { await library.deleteUnmanaged(target) }
            }
            Button("取消", role: .cancel) { unmanagedDeleteTarget = nil }
        } message: {
            Text(unmanagedDeleteTarget.map { "将删除「\($0.slot)/\($0.windowID)」，占用 \(humanBytes($0.bytes))。这个窗口的对话和资料会一起消失。" } ?? "")
        }
        .confirmationDialog("确认清理会话副本？", isPresented: $library.showCleanupConfirm, titleVisibility: .visible) {
            Button("删除并释放空间", role: .destructive) { Task { await library.applyCleanup() } }
            Button("取消", role: .cancel) { }
        } message: {
            Text(library.cleanupPrompt)
        }
        .confirmationDialog("确认删除官方库的已归档会话？", isPresented: $library.showOfficialConfirm, titleVisibility: .visible) {
            Button("删除，且不可恢复", role: .destructive) { Task { await library.applyOfficialCleanup() } }
            Button("取消", role: .cancel) { }
        } message: {
            Text(library.officialCleanupPrompt)
        }
        .alert(isPresented: $library.showUpdateAlert) {
            let latest = library.updateInfo?.latestVersion ?? "新版本"
            let note = library.updateInfo?.notes?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let summary = note.isEmpty ? "GitHub 上有新的 Model Router 版本。" : String(note.prefix(700))
            return Alert(
                title: Text("发现 Model Router \(latest)"),
                message: Text(summary),
                primaryButton: .default(Text("下载并安装")) {
                    Task { await library.installUpdate(currentVersion: bundleVersion) }
                },
                secondaryButton: .cancel(Text("稍后"))
            )
        }
        // 从 Codex 切回来就自动刷新一次：用户刚在 Codex 顶部换了模型，
        // 卡片上的「当前模型」必须立刻跟上，否则又变成「我切了但界面没变」。
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await library.openSwitch() }
        }
        .onReceive(updateTimer) { _ in
            Task { await library.checkForUpdates(currentVersion: bundleVersion, silent: true) }
        }
        .onAppear { sizeWindowOnce() }
        .task {
            await library.refresh()
            await library.openSwitch()
            // 启动时就把磁盘占用算出来，底部的状态条才有内容。
            await library.refreshDisk()
            await library.checkForUpdates(currentVersion: bundleVersion, silent: true)
            if library.newWindowModel.isEmpty, let first = library.switchModels.first { library.newWindowModel = first.id }
        }
    }

    // 打开时给一个舒服的初始尺寸。用代码设而不是 .defaultSize，
    // 是因为后者要 macOS 13+，那会把 macOS 12 的机器挡在门外。
    private func sizeWindowOnce() {
        guard !didSizeWindow else { return }
        didSizeWindow = true
        DispatchQueue.main.async {
            guard let window = NSApp.windows.first(where: { $0.isVisible }) else { return }
            let target = NSSize(width: 1040, height: 780)
            if window.frame.width < target.width || window.frame.height < target.height {
                window.setContentSize(target)
                window.center()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "square.stack.3d.up.fill").font(.title2).foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("Model Router").font(.headline)
                Text("MODEL ROUTER · \(bundleVersion)").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            }
            Spacer()
            if library.busy { ProgressView().controlSize(.small) }
            if library.updateInfo?.available == true {
                Button("新版 \(library.updateInfo?.latestVersion ?? "")") { library.showUpdateAlert = true }
                    .controlSize(.small)
                    .help("GitHub 上有新版，点击查看并安装")
            }
            Button { Task { await library.openSwitch() } } label: { Image(systemName: "arrow.clockwise") }
                .help("刷新窗口状态")
            Button { showModels = true } label: { Label("模型库（\(library.models.count)）", systemImage: "slider.horizontal.3") }
                .help("配置模型、检查连接、看诊断——都在这一个弹窗里")
            Menu {
                Button("运行诊断") {
                    showModels = true
                    Task { await library.perform("diagnostics") }
                }
                Button("打开 ChatGPT Desktop（官方）") { Task { await library.openCodex("official") } }
                Button("检查更新…") { Task { await library.checkForUpdates(currentVersion: bundleVersion, silent: false) } }
                Divider()
                Divider()
                Button("导入模型配置…") { Task { await library.importLibrary() } }
                Button("导出模型配置…") { Task { await library.exportLibrary() } }
                Divider()
                Button("打开数据目录") { NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/.codex/model-assistant")) }
            } label: { Image(systemName: "ellipsis.circle") }
            .menuStyle(.borderlessButton).frame(width: 30).help("备份与诊断")
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
    }

    // 主区域：一张张窗口卡片，点一下就进去；要再开一个就点「新建窗口」那张虚线卡。
    private var windowBoard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 8) {
                    Text("窗口").font(.title3.bold())
                    Text("\(library.windows.count) 个 · 运行中 \(library.runningWindowCount)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(library.runningWindowCount > 0 ? .green : .secondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background((library.runningWindowCount > 0 ? Color.green : Color.secondary).opacity(0.12), in: Capsule())
                    Spacer()
                    Text("每个窗口就是一个独立 Codex：有自己的任务库，窗口里随时换模型，对话不会丢。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 340), spacing: 14)], spacing: 14) {
                    officialCodexCard
                    ForEach(library.windows) { window in windowCard(window) }
                    newWindowCard
                }
                liveThreadsSection
                if let latest = library.fallbacks.first { fallbackBanner(latest) }
                if !library.orphans.isEmpty { orphanRow }
                if !library.unmanaged.isEmpty { unmanagedSection }
            }
            .padding(20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // 「钱正在从哪出去」。Codex 的模型是按对话记的，不是按窗口：一个窗口里的旧对话
    // 会一直用它当初选的模型。所以常出现「窗口写着 opencode，另一个对话还在扣
    // DeepSeek 官方」——这一块把每个对话的归属摊开，按扣费性质上色，花真金白银的
    // 那类最扎眼。用户拿它跟两边后台对账，比任何解释都直接。
    @ViewBuilder
    private var liveThreadsSection: some View {
        if !library.liveThreads.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "creditcard").font(.caption).foregroundStyle(.secondary)
                    Text("正在跑的对话").font(.headline)
                    Text("\(library.liveThreads.count) 个 · \(liveThreadSummary)")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text("模型是按对话记的：换窗口不等于换对话的模型。")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(library.liveThreads.prefix(6)) { thread in liveThreadRow(thread) }
                if library.liveThreads.count > 6 {
                    Text("还有 \(library.liveThreads.count - 6) 个对话在最近半小时内动过").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.secondary.opacity(0.2)))
        }
    }

    private var liveThreadSummary: String {
        var counts: [String: Int] = [:]
        for thread in library.liveThreads {
            let label = thread.billing?.label ?? "未知上游"
            counts[label, default: 0] += 1
        }
        return counts.sorted { $0.value > $1.value }.map { "\($0.key) ×\($0.value)" }.joined(separator: "、")
    }

    private func liveThreadRow(_ thread: LiveThread) -> some View {
        Button {
            Task { await library.openThread(thread) }
        } label: {
            HStack(spacing: 9) {
                Circle().fill(threadColor(thread)).frame(width: 7, height: 7)
                Text(thread.scope ?? "未知窗口")
                    .font(.caption.weight(.semibold)).lineLimit(1).frame(width: 76, alignment: .leading)
                Text(thread.place).font(.caption.weight(.semibold)).lineLimit(1).frame(width: 92, alignment: .leading)
                Text(thread.headline).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text("#\(thread.id.prefix(8))").font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
                Spacer(minLength: 6)
                Text((thread.model?.isEmpty == false ? thread.model : nil) ?? "未记录模型")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                Text(thread.billing?.label ?? "未知上游")
                    .font(.caption.weight(.semibold)).foregroundStyle(threadColor(thread)).lineLimit(1)
                Text("\(thread.minutesAgo ?? 0) 分钟前").font(.caption2).foregroundStyle(.secondary)
                Image(systemName: "arrow.up.forward.app").font(.caption2).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("复制 Thread ID") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(thread.id, forType: .string)
            }
            if let cwd = thread.cwd, !cwd.isEmpty {
                Button("复制工作目录") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(cwd, forType: .string)
                }
            }
        }
        .help("点击打开所属窗口｜Thread \(thread.id) ｜ \(thread.scope ?? "未知窗口") ｜ 目录 \(thread.cwd ?? "?") ｜ provider \(thread.providerID ?? "?") ｜ route \(thread.routeName ?? thread.routeID ?? "未记录") ｜ 模型 \((thread.model?.isEmpty == false ? thread.model : nil) ?? "未记录") ｜ 费用：\(thread.billing?.label ?? "未知")（\(thread.billing?.detail ?? "")）")
    }

    // 按量计费的花的是真金白银，用橙色；订阅和包月额度是已经付过的，压成冷色。
    private func threadColor(_ thread: LiveThread) -> Color {
        switch thread.billing?.kind {
        case "balance": return .orange
        case "subscription": return .blue
        case "quota": return .green
        case "direct": return .purple
        default: return .secondary
        }
    }

    // 静默 fallback 花钱这件事必须显眼：用户选了订阅制的模型，
    // 结果请求失败后网关改用按量计费的备用条目，账单上却看不出来。
    private func fallbackBanner(_ event: FallbackEvent) -> some View {
        let stillConfigured = library.models.first { $0.id == event.from }?.fallback == event.to
        let linkedThread = event.sessionId.flatMap { id in library.liveThreads.first { $0.id == id } }
        let recent = fallbackIsRecent(event)
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: recent ? "exclamationmark.triangle.fill" : "clock.arrow.circlepath")
                .foregroundStyle(recent ? .orange : .secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("\(recent ? "备用模型触发记录" : "历史备用切换记录")：\(event.fromName) → \(event.toName)")
                    .font(.caption.weight(.semibold))
                Text("fallback 只对那一次失败请求生效，不代表这个窗口或所有对话之后一直使用备用模型。发生时间：\(event.at)　原因：\(event.reason ?? "未记录")")
                    .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text(stillConfigured ? "当前规则：这个首选模型仍配置了该备用模型，下一次失败仍可能再次触发。" : "当前规则：这个备用配置现在已经不存在；这里展示的是历史事件。")
                    .font(.caption2).foregroundStyle(stillConfigured ? .orange : .secondary)
                if let thread = linkedThread {
                    Button("打开对应对话所在窗口：\(thread.scope ?? "?") · \(thread.place) · \(thread.headline) · #\(thread.id.prefix(8))") {
                        Task { await library.openThread(thread) }
                    }
                    .buttonStyle(.link).font(.caption2)
                } else if let sessionId = event.sessionId, !sessionId.isEmpty {
                    Text("Thread：\(sessionId)（当前不在最近活跃对话列表，可复制 ID 追踪）")
                        .font(.caption2).foregroundStyle(.secondary)
                        .contextMenu {
                            Button("复制 Thread ID") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(sessionId, forType: .string)
                            }
                        }
                } else {
                    Text("旧版本事件没有记录 Thread ID，因此这一次无法再追溯到具体对话；3.0.3 起的新事件会精确绑定对话。")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(12)
        .background((recent ? Color.orange : Color.secondary).opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }

    private func fallbackIsRecent(_ event: FallbackEvent) -> Bool {
        guard let date = ISO8601DateFormatter().date(from: event.at) else { return false }
        return Date().timeIntervalSince(date) < 6 * 3600
    }

    private var officialCodexCard: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Image(systemName: "app.badge.checkmark").foregroundStyle(.blue)
                Text("ChatGPT Desktop（官方）").font(.system(size: 15, weight: .semibold))
                Text("原版").font(.system(size: 10, weight: .semibold)).foregroundStyle(.blue)
                    .padding(.horizontal, 6).padding(.vertical, 2).background(Color.blue.opacity(0.12), in: Capsule())
                Spacer()
            }
            Text("打开系统里的官方 ChatGPT Desktop / Codex 默认资料：复用你的登录账号、原任务库和官方模型选择器。")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text("不经过模型助手路由 · 不创建独立 CODEX_HOME · 不使用 --user-data-dir")
                .font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                Button("打开 / 切到 ChatGPT Desktop") { Task { await library.openCodex("official") } }
                    .buttonStyle(.borderedProminent).controlSize(.small).disabled(library.busy)
                Spacer()
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 172, alignment: .topLeading)
        .background(Color.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.blue.opacity(0.32), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .onTapGesture { Task { await library.openCodex("official") } }
        .help("打开官方 ChatGPT Desktop / Codex 默认资料。Dock 图标会和可切换窗口共用，因此从这里进入最明确。")
    }

    private func windowCard(_ window: WorkWindow) -> some View {
        let running = window.running == true
        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Circle().fill(running ? Color.green : Color.secondary.opacity(0.35)).frame(width: 8, height: 8)
                Text(window.name).font(.system(size: 15, weight: .semibold))
                if window.legacy == true {
                    Text("内置").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                        .padding(.horizontal, 6).padding(.vertical, 2).background(Color.secondary.opacity(0.14), in: Capsule())
                }
                Spacer()
                Menu {
                    Button("打开（已在跑就切到最前）") { Task { await library.openWindow(window.id) } }.disabled(library.busy)
                    Button("置前") { Task { await library.bringWindowToFront(window.id) } }.disabled(library.busy || !running)
                    Button("关闭窗口") { Task { await library.closeWindow(window.id) } }.disabled(library.busy || !running)
                    Divider()
                    Button("重命名…") { renameDraft = window.name; renameTarget = window }
                    Button("用这个窗口的起始模型再开一个") { Task { await library.newWindow(initial: window.initialModel ?? "") } }.disabled(library.busy)
                    Divider()
                    Button("删除窗口", role: .destructive) { Task { await library.deleteWindow(window.id) } }
                        .disabled(window.legacy == true || running)
                } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).frame(width: 26)
            }
            Text(running ? "运行中 · PID \(window.pid ?? 0)" : "未启动")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(running ? .green : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text("当前模型：\(library.displayName(forModelKey: window.currentModel) ?? "打开后在 Codex 顶部选择")")
                    .font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                Text("启动时：\(library.displayName(forModelKey: window.initialModel) ?? "自动")")
                    .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                Button(running ? "切到最前" : "打开") { Task { await library.openWindow(window.id) } }
                    .buttonStyle(.borderedProminent).controlSize(.small).disabled(library.busy)
                if running {
                    Button("关闭") { Task { await library.closeWindow(window.id) } }.controlSize(.small).disabled(library.busy)
                }
                Spacer()
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 172, alignment: .topLeading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(running ? Color.green.opacity(0.35) : Color.secondary.opacity(0.15), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .onTapGesture { Task { await library.openWindow(window.id) } }
        .help(window.homePath ?? "")
    }

    // 这些是「专用单模型窗口」留下的资料目录：不写注册表，所以以前既看不见也删不掉，
    // 实测能堆到 3.8 GB。现在列出来，能打开、也能删。
    private var unmanagedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("单模型窗口").font(.callout.weight(.semibold))
                Text("\(library.unmanaged.count) 个 · 合计 \(humanBytes(library.unmanaged.reduce(Int64(0)) { $0 + ($1.bytes ?? 0) }))")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("用「⋯ → 专用单模型窗口」开出来的，每个只跑一个模型；不用了就删，腾出空间。")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            ForEach(library.unmanaged) { entry in
                HStack(spacing: 10) {
                    Image(systemName: entry.running == true ? "circle.fill" : "circle").font(.system(size: 7))
                        .foregroundStyle(entry.running == true ? .green : .secondary.opacity(0.5))
                    Text(library.displayName(forModelKey: entry.windowID) ?? entry.windowID).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Text(entry.slot).font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
                    Text(humanBytes(entry.bytes)).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                    if entry.running == true {
                        Text("运行中 · PID \(entry.pid ?? 0)").font(.system(size: 10, weight: .semibold)).foregroundStyle(.green)
                    }
                    Spacer()
                    Button("打开") { Task { await library.openUnmanaged(entry.windowID) } }.controlSize(.small).disabled(library.busy)
                    Button("删除") { unmanagedDeleteTarget = entry }.controlSize(.small)
                        .disabled(library.busy || entry.running == true)
                        .help(entry.running == true ? "正在运行，先关掉它再删" : "删掉这个窗口的资料目录，不可恢复")
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private var newWindowCard: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("新建窗口").font(.system(size: 15, weight: .semibold))
            Text("再开一个独立 Codex：自己的任务库和运行状态，可以和现有窗口同时干活。新窗口是空的，需要旧对话时用模型库里的导入。")
                .font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Picker("起始模型", selection: $library.newWindowModel) {
                ForEach(library.switchModels) { entry in Text("\(entry.name) · \(entry.model)").tag(entry.id) }
            }.labelsHidden().disabled(library.switchModels.isEmpty)
            Spacer(minLength: 0)
            Button { Task { await library.newWindow(initial: library.newWindowModel) } } label: {
                Label("新建窗口", systemImage: "plus").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered).disabled(library.busy || library.switchModels.isEmpty)
            .help("可选的起始模型 \(library.switchModels.count) 个（官方 ChatGPT 登录和已归档模型不在其中）")
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 172, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5, 4])).foregroundStyle(.secondary.opacity(0.35)))
    }

    // 「我的请求到底走了谁」：用户对扣费最直接的疑问，摊在状态条上，不用去翻日志。
    private var recentHostSummary: String? {
        // 按天累计优先：跟后台对账时看的是「今天」，不是最近 10 条。
        if let today = library.todayUsage, (today.total ?? 0) > 0 {
            let hosts = (today.hosts ?? [:]).sorted { $0.value > $1.value }.map { "\($0.key) ×\($0.value)" }
            let fallbacks = (today.fallbacks ?? [:]).reduce(0) { $0 + $1.value }
            let tail = fallbacks > 0 ? "　⚠️ 其中 \(fallbacks) 次用了备用" : ""
            return "今天 \(today.total ?? 0) 次：\(hosts.joined(separator: "、"))\(tail)"
        }
        guard !library.recentRoutes.isEmpty else { return nil }
        var counts: [String: Int] = [:]
        for entry in library.recentRoutes { counts[entry.host, default: 0] += 1 }
        let parts = counts.sorted { $0.value > $1.value }.map { "\($0.key) ×\($0.value)" }
        return "最近 \(library.recentRoutes.count) 次：\(parts.joined(separator: "、"))"
    }

    private var statusBar: some View {
        HStack(spacing: 12) {
            Image(systemName: "internaldrive").foregroundStyle(.secondary).font(.caption)
            if let disk = library.disk {
                Text("助手目录 \(humanBytes(disk.totalBytes)) · 可回收 \(humanBytes(disk.reclaimable)) · 系统剩余 \(Int(disk.freeDiskPercent.rounded()))%")
                    .font(.caption).foregroundStyle(.secondary)
                if let snapshots = disk.localSnapshots, snapshots > 0 {
                    Text("· \(snapshots) 个本地快照钉着空间").font(.caption).foregroundStyle(.orange)
                        .help("清理出来的空间会被本地 Time Machine 快照钉住，删掉快照才会真正释放")
                }
            } else {
                Text("点「检查占用」算出可回收多少").font(.caption).foregroundStyle(.secondary)
            }
            if let summary = recentHostSummary {
                Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    .help("最近几次请求实际打到的上游域名。想核对扣费方，看这一行。")
            }
            if library.busy { ProgressView().controlSize(.small) }
            Spacer()
            Text(library.message).font(.caption).foregroundStyle(library.success == false ? .red : .secondary).lineLimit(1)
            Button("检查占用") { Task { await library.refreshDisk() } }.controlSize(.small).disabled(library.busy)
            Button("清理") { library.showCleanupConfirm = true }.controlSize(.small)
                .disabled(library.busy || (library.disk?.reclaimable ?? 0) <= 0)
                .help("删除各窗口里重复的会话副本与浏览器缓存；官方库和窗口独有对话不动")
        }
        .padding(.horizontal, 18).padding(.vertical, 10)
    }

    // 模型配置收进一个弹窗：主界面不再被模型列表挤掉一半。
    private var modelLibrary: some View {
        HStack(spacing: 0) {
            modelSidebar
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("模型工作台").font(.callout.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Button { Task { await library.refresh() } } label: { Image(systemName: "arrow.clockwise") }.help("刷新配置")
                    Menu {
                        Button("导入模型配置…") { Task { await library.importLibrary() } }
                        Button("导出模型配置…") { Task { await library.exportLibrary() } }
                        Divider()
                        Button("运行诊断") { Task { await library.perform("diagnostics") } }
                        Button("打开数据目录") { NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/.codex/model-assistant")) }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton).frame(width: 28).help("备份与诊断")
                    // 关闭按钮必须是这个弹窗里最显眼的东西：macOS 的 sheet 点外面不会关，
                    // 找不到它就只能强退应用。同时保留 Esc。
                    Button("完成") { showModels = false }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.cancelAction)
                        .help("关闭模型库，回到窗口面板（按 Esc 也行）")
                }.padding(.horizontal, 20).padding(.vertical, 14)
                Divider()
                if library.diskNeedsAttention, let disk = library.disk {
                    HStack(spacing: 10) {
                        Image(systemName: "internaldrive.fill").foregroundStyle(.orange)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("助手目录占 \(humanBytes(disk.totalBytes))，可回收 \(humanBytes(disk.reclaimable))").font(.caption.weight(.semibold))
                            Text("多开的窗口各存了一份同样的会话；清理只删副本，官方库和窗口独有对话不动。").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("去清理") { library.showCleanupConfirm = true }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                            .disabled(library.busy || disk.reclaimable <= 0)
                    }
                    .padding(.horizontal, 24).padding(.vertical, 10)
                    .background(Color.orange.opacity(0.1))
                    Divider()
                }
                if let selected = library.selected { modelDetail(selected) }
                else { emptyState }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 1120, height: 700)
        // 模型库本身已经是 sheet；新增/编辑/发现/诊断必须从当前 sheet 内容继续呈现。
        // 把这些 presenter 挂在底层主窗口上时，状态会改变但 macOS 不会显示二级 sheet，表现就是按钮“点不动”。
        .sheet(item: $editing) { model in
            ModelEditor(library: library, draft: model, isNew: !library.models.contains(where: { $0.id == model.id }))
        }
        .sheet(isPresented: $library.showDiscovery) { discovery }
        .sheet(isPresented: $library.showDiagnostics) { diagnosticsSheet }
    }

    private func renameSheet(_ window: WorkWindow) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("重命名窗口").font(.title3.bold())
            TextField("窗口名称", text: $renameDraft).textFieldStyle(.roundedBorder).frame(width: 320)
            HStack {
                Spacer()
                Button("取消") { renameTarget = nil }.keyboardShortcut(.cancelAction)
                Button("保存") {
                    let target = window.id
                    let name = renameDraft
                    renameTarget = nil
                    Task { await library.renameWindow(target, to: name) }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }.padding(24)
    }

    private var diagnosticsSheet: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("运行诊断").font(.title2.bold())
            Text(library.diagnostics).font(.body).textSelection(.enabled).lineSpacing(8)
            if !library.recentRoutes.isEmpty {
                Divider()
                Text("最近请求的上游").font(.callout.weight(.semibold))
                ForEach(library.recentRoutes) { entry in
                    HStack(spacing: 10) {
                        Text(entry.at.suffix(15).prefix(8)).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                        Text(entry.host).font(.system(size: 11, design: .monospaced))
                        if entry.fallback == true { Text("备用").font(.system(size: 10, weight: .bold)).foregroundStyle(.orange) }
                        Spacer()
                        Text(entry.name ?? entry.route).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            HStack {
                Button("修复工作窗口") { Task { await library.callRepairAndRefreshDiagnostics() } }.disabled(library.busy)
                Spacer()
                Button("完成") { library.showDiagnostics = false }.keyboardShortcut(.defaultAction)
            }
        }.padding(28).frame(width: 600)
    }


    // 并发建窗丢过记录时，Codex 进程还在跑但注册表里没有它：这里一次性接管回来。
    private var orphanRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text("发现 \(library.orphans.count) 个没登记的 Codex 窗口").font(.system(size: 13, weight: .semibold))
            }
            Text("这些窗口的进程还在运行（\(library.orphans.map { "PID \($0.pid ?? 0)" }.joined(separator: "、"))），但之前不在列表里，所以看起来像「只能开一个」。接管之后就能在列表里关闭或重新打开，不会影响正在进行的对话。")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            HStack {
                Button("接管这些窗口") { Task { await library.adoptOrphans() } }.disabled(library.busy)
                Spacer()
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }

    private var modelSidebar: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "square.stack.3d.up.fill").font(.title2).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("模型库").font(.headline)
                    Text("\(library.visible.count) 个显示 · \(library.readyCount) 个可用").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { editing = ManagedModel.new() } label: { Image(systemName: "plus") }
                    .buttonStyle(.borderedProminent).controlSize(.small).help("添加模型")
            }

            TextField("搜索名称 / 供应商 / 模型 ID", text: $library.search)
                .textFieldStyle(.roundedBorder)

            HStack(spacing: 8) {
                Menu {
                    Toggle("显示归档模型", isOn: $library.showArchived)
                    Toggle("显示隐藏条目", isOn: $library.showHidden)
                } label: {
                    Label(library.showArchived || library.showHidden ? "筛选已开启" : "全部常用模型", systemImage: "line.3.horizontal.decrease.circle")
                }
                .menuStyle(.borderlessButton)
                Spacer()
                if library.busy { ProgressView().controlSize(.small) }
            }
            .font(.caption)

            Divider()

            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(library.visible) { model in
                        Button { library.select(model.id) } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: model.icon)
                                    .foregroundStyle(model.color)
                                    .frame(width: 26, height: 26)
                                    .background(model.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 6) {
                                        Text(model.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                                        if library.isRunning(model) {
                                            Circle().fill(Color.green).frame(width: 6, height: 6).help("此 Codex 实例已启动")
                                        }
                                    }
                                    Text(model.vendor).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
                                    Text(model.protocol == "oauth" ? "模型由 ChatGPT Desktop 内选择" : (model.model.isEmpty ? "尚未选择模型 ID" : model.model))
                                        .font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
                                }
                                Spacer(minLength: 8)
                                if !model.ready {
                                    Image(systemName: "wrench.and.screwdriver").font(.caption).foregroundStyle(.orange)
                                }
                            }
                            .padding(.horizontal, 10).padding(.vertical, 9)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                            .background(library.selectedID == model.id ? Color.accentColor.opacity(0.16) : Color.clear, in: RoundedRectangle(cornerRadius: 9))
                            .overlay(RoundedRectangle(cornerRadius: 9).stroke(library.selectedID == model.id ? Color.accentColor.opacity(0.35) : Color.secondary.opacity(0.08)))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("选择 \(model.name)")
                        .disabled(library.busy)
                    }
                    if library.visible.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "magnifyingglass").font(.title2).foregroundStyle(.secondary)
                            Text("没有匹配的模型").foregroundStyle(.secondary)
                        }.padding(.top, 30)
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(maxHeight: .infinity)

            Divider()
            compactDiskBar
        }
        .padding(14)
        .frame(width: 360)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var compactDiskBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "internaldrive").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                if let disk = library.disk {
                    Text("助手目录 \(humanBytes(disk.totalBytes)) · 可回收 \(humanBytes(disk.reclaimable))")
                        .font(.caption2.weight(.semibold)).lineLimit(1)
                    Text("系统剩余 \(Int(disk.freeDiskPercent.rounded()))%")
                        .font(.caption2).foregroundStyle(.secondary)
                } else {
                    Text("磁盘占用未检查").font(.caption2.weight(.semibold))
                }
            }
            Spacer()
            Button("检查") { Task { await library.refreshDisk() } }.controlSize(.mini).disabled(library.busy)
            if (library.disk?.reclaimable ?? 0) > 0 {
                Button("清理") { library.showCleanupConfirm = true }.controlSize(.mini).disabled(library.busy)
            }
        }
        .padding(.top, 2)
    }

    // 磁盘：同一批会话在每个窗口各存一份，是这套多开机制最容易失控的地方，所以放在侧边栏常驻可见。
    private var diskSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("磁盘").font(.caption.weight(.semibold))
                Spacer()
                if let disk = library.disk {
                    Text("可回收 \(humanBytes(disk.reclaimable))")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(disk.reclaimable > 0 ? .orange : .secondary)
                }
            }
            if let disk = library.disk {
                Text("助手目录 \(humanBytes(disk.totalBytes)) · 系统剩余 \(Int(disk.freeDiskPercent.rounded()))%")
                    .font(.caption2).foregroundStyle(.secondary)
                if let plan = library.diskPlan, let count = plan.items?.count, count > 0 {
                    Text("\(count) 个会话副本可清 · \(plan.keepOriginals?.count ?? 0) 条原件保留")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let plan = library.diskPlan, let caches = plan.caches, caches.count > 0 {
                    Text("\(caches.count) 个浏览器缓存可清 · \(humanBytes(caches.bytes))，下次打开自动重建")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let official = library.officialArchive, let count = official.count, count > 0 {
                    Text(official.officialRunning == true
                         ? "官方库有 \(count) 条已归档会话（\(humanBytes(official.bytes))）；ChatGPT Desktop（官方）正在运行，先退出它才能清"
                         : "官方库有 \(count) 条已归档会话可清 · \(humanBytes(official.bytes))（原件，不可恢复）")
                        .font(.caption2).foregroundStyle(official.officialRunning == true ? Color.secondary : Color.orange)
                }
                if let snapshots = disk.localSnapshots, snapshots > 0 {
                    Text("有 \(snapshots) 个本地 Time Machine 快照：刚清出来的空间会被它们钉住，磁盘数字不会立刻变大。\n删快照要管理员密码：sudo tmutil deletelocalsnapshots /（会丢掉那个恢复点）")
                        .font(.caption2).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let skipped = library.diskPlan?.skipped, !skipped.isEmpty {
                    // 一般只有一个窗口在跑，合成一段文本比 ForEach 更省事，也避免结果构建器里的重载歧义。
                    Text(skipped.map { "\($0.id) 正在运行：还有 \(humanBytes($0.bytes)) 等它关闭后自动清理" }.joined(separator: "\n"))
                        .font(.caption2).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("点「检查占用」算出可回收多少").font(.caption2).foregroundStyle(.secondary)
            }
            if let policy = library.diskPolicy {
                Toggle(isOn: Binding(
                    get: { policy.autoCleanupOnLaunch ?? true },
                    set: { value in Task { await library.setAutoCleanup(value) } }
                )) {
                    Text("启动窗口前自动清理不重要副本").font(.caption2)
                }
                .toggleStyle(.switch)
                .controlSize(.mini)
                .disabled(library.busy)
                .help("只清「官方已归档」或「超 30 天」的会话副本和浏览器缓存；官方库、窗口独有对话一律不动。随时可关。")
            }
            HStack(spacing: 6) {
                Button { Task { await library.refreshDisk() } } label: { Label("检查占用", systemImage: "internaldrive").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).disabled(library.busy)
                Button { library.showCleanupConfirm = true } label: { Label("清理", systemImage: "trash").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).disabled(library.busy || (library.disk?.reclaimable ?? 0) <= 0)
                    .help("删除各窗口里重复的会话副本与浏览器缓存，释放磁盘；官方库和窗口独有对话不动")
            }
            if let official = library.officialArchive, let count = official.count, count > 0 {
                Button { library.showOfficialConfirm = true } label: {
                    Label("清理官方库已归档 (\(count))", systemImage: "archivebox").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(library.busy || official.officialRunning == true)
                .help("只删官方库里【已归档】的会话，原件不可恢复；未归档的一条都不动")
            }
        }
    }

    // 不用 ContentUnavailableView：那个只有 macOS 14+ 才有，
    // 而我们要让这台 app 在更老的系统上也能打开。自己画一个，效果一样、不挑系统。
    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "square.stack.3d.up").font(.system(size: 34)).foregroundStyle(.secondary)
            Text("还没有模型").font(.title3.weight(.semibold))
            Text("点「添加模型」，选择供应商模板开始配置。").font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func modelDetail(_ model: ManagedModel) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.vendor).font(.callout).foregroundStyle(.secondary)
                    Text(model.name).font(.system(size: 27, weight: .bold)).lineLimit(2)
                    Text(model.protocol == "oauth" ? "官方 ChatGPT 登录" : (model.noKey ? "本机 / 局域网服务" : "API Key · 由供应商独立计费")).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Text(model.status).font(.caption.weight(.semibold)).padding(.horizontal, 10).padding(.vertical, 6)
                    .background(model.ready ? Color.blue.opacity(0.1) : Color.orange.opacity(0.12), in: Capsule())
            }
            VStack(spacing: 0) {
                row("模型 ID", model.protocol == "oauth" ? "由 ChatGPT Desktop 内选择" : (model.model.isEmpty ? "未选择 · 使用发现模型或编辑" : model.model))
                Divider()
                row("API 地址", model.protocol == "oauth" ? "ChatGPT 官方服务" : model.endpoint)
                Divider()
                row("接口格式", model.protocol == "oauth" ? "官方登录" : model.protocol)
                Divider()
                row("密钥状态", model.protocol == "oauth" ? "使用 ChatGPT Desktop 登录信息" : (model.noKey ? "无需密钥" : (model.hasKey == true ? "已保存 · 不展示原文" : "未配置 API Key")))
                Divider()
                row("可切换窗口", model.protocol == "oauth" ? "不经过 Model Router 工作窗口" : (model.archived ? "已归档，不收录" : (library.switchModels.contains { $0.id == model.id } ? "已收录 · 同一窗口直接换" : "未收录")))
                Divider()
                row("本窗口模型", model.protocol == "oauth" ? "由 ChatGPT Desktop 内选择" : (model.switchable == true ? "可切换全部模型" : "仅此模型"))
                Divider()
                row("Codex 环境", model.protocol == "oauth" ? "Full · 官方" : ((model.runtimeProfile ?? "auto") == "full" ? "Full · 完整工具" : ((model.runtimeProfile ?? "auto") == "lite" ? "Lite · 轻量" : "Auto · 本地轻量 / 云端完整")))
                Divider()
                row("失败时改用", model.protocol == "oauth" ? "不适用" : (model.fallback.flatMap { id in library.models.first { $0.id == id }?.name } ?? "未设置"))
            }.padding(.horizontal, 16).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 10) {
                if model.protocol != "oauth" {
                    Button("编辑配置 / Key") { editing = model }
                    Button("发现模型") { Task { await library.perform("discover") } }.disabled(!model.noKey && model.hasKey != true)
                    Button("自动识别接口") { Task { await library.perform("autodetect") } }.disabled(!model.ready || model.archived).help("逐个真跑一次最小请求，自动判断该供应商用的是 Responses、Chat 还是 Messages，并保存结果")
                }
                if !model.docs.isEmpty, let url = URL(string: model.docs) { Link("官方文档 ↗", destination: url).font(.callout) }
                Spacer()
            }.disabled(library.busy)
            if !model.notes.isEmpty { Text(model.notes).font(.callout).foregroundStyle(.secondary).lineLimit(3) }
            HStack(alignment: .top, spacing: 10) {
                if library.busy { ProgressView().controlSize(.small) }
                else { Image(systemName: library.success == false ? "exclamationmark.circle.fill" : (library.success == true ? "checkmark.circle.fill" : "info.circle")) }
                Text(library.message).font(.callout).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .foregroundStyle(library.success == false ? Color.red : Color.primary)
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(library.success == false ? Color.red.opacity(0.07) : Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            Spacer(minLength: 0)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "macwindow.on.rectangle").foregroundStyle(.secondary)
                Text("只想换模型、继续同一个对话：用「在可切换窗口中打开」，之后在 Codex 顶部的模型选择里直接换，窗口和对话不变。想给某个模型单独一个专用窗口：用「启动 Codex」，旧任务可用「导入原会话并继续」复制一份；副本与原件不会自动同步，任务内容都会发送给所选供应商。").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if model.id != "official" { Button(model.archived ? "恢复模型" : "归档") { Task { await library.archive() } } }
                Spacer()
                Button(model.protocol == "oauth" ? "检查登录" : "检查连接") { Task { await library.perform("check") } }.disabled(!model.ready || model.archived)
                if model.protocol == "oauth" {
                    Button("打开 ChatGPT Desktop") { Task { await library.openCodex(model.id) } }.buttonStyle(.borderedProminent)
                        .help("打开官方 ChatGPT Desktop / Codex 默认资料、登录状态和任务库")
                } else {
                    Button("真实验证") { Task { await library.perform("probe") } }.disabled(!model.ready || model.archived).help("发送短测试请求，消耗少量供应商额度")
                    Button("打开 Codex") { Task { await library.openCodex(model.id) } }.buttonStyle(.borderedProminent).disabled(!model.ready || model.archived)
                        .help("已经开着的窗口就切过去，没有窗口才新建。到 Codex 顶部的模型选择里换模型即可")
                    Button("新建窗口") { Task { await library.newWindow(initial: model.id) } }.disabled(!model.ready || model.archived)
                        .help("再开一个独立的 Codex 窗口，用这个模型作为起始模型；想看两个模型同时干活时用")
                    Menu {
                        Button("专用单模型窗口（不复用已有窗口）") { Task { await library.perform("launch") } }.disabled(!model.ready || model.archived)
                        Button("导入官方会话并继续") { Task { await library.perform("continue") } }.disabled(!model.ready || model.archived)
                        if model.switchable == true {
                            Button("本窗口改为单模型") { Task { await library.perform("disable-switching") } }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton).frame(width: 28)
                }
            }.disabled(library.busy)
        }.padding(28)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(spacing: 16) {
            Text(label).font(.callout).foregroundStyle(.secondary).frame(width: 76, alignment: .leading)
            Text(value).font(.system(size: 12, weight: .medium, design: .monospaced)).textSelection(.enabled).lineLimit(2).truncationMode(.middle)
            Spacer(minLength: 0)
        }.padding(.vertical, 12)
    }

    private var discovery: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("选择供应商模型").font(.title2.bold())
            Text("共 \(library.discovered.count) 个候选（含当前模型）。可在编辑配置中手动输入模型 ID；目录不代表套餐支持，实际可用性以真实验证为准。").font(.callout).foregroundStyle(.secondary)
            TextField("筛选模型 ID", text: $library.discoveryFilter).textFieldStyle(.roundedBorder)
            List(library.discovered.filter { library.discoveryFilter.isEmpty || $0.localizedCaseInsensitiveContains(library.discoveryFilter) }, id: \.self) { id in
                Button {
                    guard var model = library.selected else { return }
                    model.model = id
                    Task { if await library.save(model) { library.showDiscovery = false } }
                } label: { HStack { Text(id); Spacer(); Image(systemName: "plus.circle") } }
                .buttonStyle(.plain).disabled(library.busy)
            }
            HStack { Spacer(); Button("关闭") { library.showDiscovery = false }.keyboardShortcut(.cancelAction) }
        }.padding(24).frame(width: 600, height: 530)
    }
}

@main
struct CodexModelAssistantApp: App {

    var body: some Scene {
        // 不用 .defaultSize：它是 macOS 13+，而 SceneBuilder 里又不能写 if #available。
        // 窗口初始尺寸改在视图出现时自己设（见 ModelLibraryView.sizeWindowOnce），
        // 这样 macOS 12 的机器也能装、也能开。
        WindowGroup { ModelLibraryView() }
            .commands { CommandGroup(replacing: .newItem) { } }
    }
}
