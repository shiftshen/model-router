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
            Form {
                if isNew {
                    Picker("供应商模板", selection: $templateID) {
                        Text("自定义兼容服务").tag("custom")
                        ForEach(library.templates.filter { $0.id != "custom" }) { template in Text(template.name).tag(template.id) }
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
                    }
                }
                TextField("显示名称", text: $draft.name)
                TextField("供应商", text: $draft.vendor)
                if draft.protocol == "oauth" {
                    Picker("官方模型", selection: $draft.model) {
                        ForEach(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini"], id: \.self) { model in Text(model).tag(model) }
                    }
                } else {
                    TextField("模型 ID", text: $draft.model, prompt: Text("可先保存，再使用「发现模型」选择"))
                }
                if draft.protocol != "oauth" {
                    TextField("API 地址", text: $draft.endpoint)
                    Text("可以直接粘贴控制台地址（例如 http://127.0.0.1:8080/#accounts）或只写到主机名，保存时会自动补成可用的服务地址。").font(.caption).foregroundStyle(.secondary)
                    Picker("接口格式", selection: $draft.protocol) {
                        Text("Responses API").tag("responses")
                        Text("Chat Completions").tag("chat")
                        Text("Anthropic Messages").tag("anthropic")
                    }
                    Text("不确定选哪个就保持默认，保存后点「自动识别接口」：助手会逐个真跑一次最小请求，把能用的那套记下来。").font(.caption).foregroundStyle(.secondary)
                    Picker("主模型失败时改用", selection: $draft.fallback) {
                        Text("不设置").tag(Optional<String>.none)
                        ForEach(library.models.filter { $0.id != draft.id && $0.protocol != "oauth" && !$0.archived }) { candidate in
                            Text("\(candidate.name)（\(candidate.model.isEmpty ? candidate.id : candidate.model)）").tag(Optional(candidate.id))
                        }
                    }
                    Text("额度用尽、限流或服务异常时自动改用这个模型，任务不用重来；正常时不调用它。改用的模型在回复里不会额外提示。").font(.caption).foregroundStyle(.secondary)
                    Picker("Codex 环境", selection: Binding(
                        get: { draft.runtimeProfile ?? "auto" },
                        set: { draft.runtimeProfile = $0 }
                    )) {
                        Text("自动（本地无 Key 模型用轻量）").tag("auto")
                        Text("轻量 Lite（少工具 / 少上下文）").tag("lite")
                        Text("完整 Full（Plugins / MCP / Skills）").tag("full")
                    }
                    Text("Auto 对本地无 Key 模型使用 Lite，云端模型使用 Full。环境类型更改后重开窗口生效；需要连接器、WebCodex 或完整工具生态时可选择 Full。").font(.caption).foregroundStyle(.secondary)
                    Toggle("无需 API Key（本地服务）", isOn: $draft.noKey)
                    if !draft.noKey {
                        SecureField(draft.hasKey == true ? "新 API Key（留空保留）" : "API Key", text: $key).textContentType(.password)
                        Text("同供应商模板默认共用 Key。修改 API 地址后需要重新输入 Key。").font(.caption).foregroundStyle(.secondary)
                        if draft.hasKey == true { Toggle("清除已保存的 Key", isOn: $clearKey).tint(.red) }
                    }
                } else {
                    Text("使用现有 ChatGPT 登录；API Key 不适用于此入口。").font(.callout).foregroundStyle(.secondary)
                }
                TextField("上下文 Token 数", value: $draft.contextWindow, format: .number.grouping(.never))
                TextField("备注", text: $draft.notes)
            }
            .frame(minHeight: 350)
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
        .padding(24)
        .frame(width: 610, height: 650)
        .interactiveDismissDisabled(library.busy)
    }
}
