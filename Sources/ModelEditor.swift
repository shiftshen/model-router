import SwiftUI

struct ModelEditor: View {
    @ObservedObject var library: LibraryViewModel
    @State var draft: ManagedModel
    let isNew: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var templateID = "custom"
    @State private var key = ""
    @State private var clearKey = false
    @State private var error = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(isNew ? "添加模型" : "编辑模型").font(.title2.bold())
                    Text("配置保存在本机，密钥不会包含在导出文件中。").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "slider.horizontal.3").font(.title).foregroundStyle(.tint)
            }
            ScrollView {
              VStack(alignment: .leading, spacing: 18) {
                if isNew {
                    editorField("供应商模板") {
                        Picker("供应商模板", selection: $templateID) {
                            Text("自定义兼容服务").tag("custom")
                            ForEach(library.templates.filter { $0.id != "custom" }) { template in Text(template.name).tag(template.id) }
                        }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                    }
                    // 用单参数写法：双参数闭包（onChange(of:initial:_:)）要 macOS 14+，
                    // 单参数从 macOS 11 就有，老系统上一样好使。
                    .onChange(of: templateID) { value in
                        guard let template = library.templates.first(where: { $0.id == value }) else { return }
                        draft.name = template.name
                        draft.vendor = template.name
                        draft.endpoint = template.endpoint
                        draft.protocol = template.protocol
                        draft.model = template.model
                        draft.docs = template.docs
                        draft.noKey = template.noKey ?? false
                        draft.credentialID = template.id == "custom" ? draft.id : template.id
                        if draft.contextWindowAuto == true { draft.contextWindow = 0 }
                    }
                }
                HStack(alignment: .top, spacing: 16) {
                    editorField("显示名称") { TextField("例如 MiMo Flash", text: $draft.name).textFieldStyle(.roundedBorder) }
                    editorField("供应商") { TextField("例如 小米", text: $draft.vendor).textFieldStyle(.roundedBorder) }
                }
                if draft.protocol == "oauth" {
                    Text("官方原版只用于登录与续期；工作窗口会自动同步官方模型。")
                } else {
                    editorField("模型 ID") { TextField("可手动输入，也可保存后发现模型", text: $draft.model).textFieldStyle(.roundedBorder) }
                }
                if draft.protocol != "oauth" {
                    if draft.protocol == "chatgpt" {
                        Text("使用官方客户端的登录账号与订阅额度；无需 Key，切第三方无需退出登录。").font(.caption).foregroundStyle(.secondary)
                    } else {
                        editorField("API 地址") {
                            TextField("https://api.example.com/v1", text: $draft.endpoint).textFieldStyle(.roundedBorder)
                            Text("留空不会默认连接 DeepSeek。可粘贴控制台地址或主机名，保存时自动整理地址。")
                                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    HStack(alignment: .top, spacing: 16) {
                        editorField("接口格式") {
                            Picker("接口格式", selection: $draft.protocol) {
                                Text("ChatGPT 登录订阅").tag("chatgpt")
                                Text("Responses API").tag("responses")
                                Text("Chat Completions").tag("chat")
                                Text("Anthropic Messages").tag("anthropic")
                            }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        }
                        editorField("失败时改用") {
                            Picker("失败时改用", selection: $draft.fallback) {
                                Text("不设置").tag(Optional<String>.none)
                                ForEach(library.models.filter { $0.id != draft.id && $0.protocol != "oauth" && !$0.archived }) { candidate in
                                    Text(candidate.name).tag(Optional(candidate.id))
                                }
                            }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    Text("不确定接口格式可先保持 Responses，保存后点「自动识别接口」。备用模型仅在额度、限流或服务异常时调用。")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    editorField("Codex 环境") {
                        Picker("Codex 环境", selection: Binding(
                            get: { draft.runtimeProfile ?? "auto" },
                            set: { draft.runtimeProfile = $0 }
                        )) {
                            Text("自动（本地无 Key 模型用轻量）").tag("auto")
                            Text("轻量 Lite（少工具 / 少上下文）").tag("lite")
                            Text("完整 Full（Plugins / MCP / Skills）").tag("full")
                        }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        Text("云端模型默认 Full；更改环境类型后重开工作窗口生效。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if draft.protocol != "chatgpt" { Toggle("无需 API Key（本地服务）", isOn: $draft.noKey) }
                    if !draft.noKey && draft.protocol != "chatgpt" {
                        editorField("API Key") {
                            SecureField(draft.hasKey == true ? "留空保留现有 Key" : "输入供应商 API Key", text: $key)
                                .textFieldStyle(.roundedBorder).textContentType(.password)
                            Text("同供应商模板默认共用 Key；修改 API 地址后需要重新输入。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if draft.hasKey == true { Toggle("清除已保存的 Key", isOn: $clearKey).tint(.red) }
                    }
                } else {
                    Text("使用现有 ChatGPT 登录；API Key 不适用于此入口。").font(.callout).foregroundStyle(.secondary)
                }
                Divider()
                editorField("上下文长度") {
                    Toggle("按模型自动设置", isOn: Binding(
                        get: { draft.contextWindowAuto ?? false },
                        set: { enabled in
                            draft.contextWindowAuto = enabled
                            if enabled { draft.contextWindow = 0 }
                        }
                    ))
                    if draft.contextWindowAuto == true {
                        Text(draft.contextWindow > 0
                             ? "当前为 \(draft.contextWindow.formatted()) Token；修改模型 ID 后保存会重新匹配。"
                             : "保存时按模型 ID 匹配已知上限；未知模型暂按 512,000 Token，并可手动修正。")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    } else {
                        TextField("输入 Token 数", value: $draft.contextWindow, format: .number.grouping(.never))
                            .textFieldStyle(.roundedBorder)
                        Text("手动值会保持不变；请以供应商文档或实际报错给出的上限为准。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                editorField("备注") { TextField("可选", text: $draft.notes).textFieldStyle(.roundedBorder) }
              }
              .padding(.trailing, 10)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red).font(.callout).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Text("修改后请重新验证连接。").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(library.busy ? "保存中…" : "保存模型") {
                    Task {
                        if await library.save(draft, key: key, clearKey: clearKey) { key = ""; dismiss() }
                        else { error = library.message }
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(library.busy || draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(28)
        .frame(width: 720, height: 720)
        .interactiveDismissDisabled(library.busy)
    }

    private func editorField<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.callout.weight(.semibold)).foregroundStyle(.secondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
