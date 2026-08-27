import AppKit
import SwiftUI

/// A one-time, installation-scoped language choice. It deliberately writes to
/// the same AppSettings field used by Settings so there is only one source of
/// truth for localization throughout the app.
struct LanguageOnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedLanguage: String

    init() {
        _selectedLanguage = State(initialValue: Self.suggestedLanguage())
    }

    private var copy: OnboardCopy {
        switch selectedLanguage {
        case "en": return .english
        case "zh-Hant": return .traditional
        default: return .simplified
        }
    }

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor).ignoresSafeArea()

            VStack(spacing: 30) {
                VStack(spacing: 14) {
                    Image(nsImage: NSApplication.shared.applicationIconImage)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 76, height: 76)
                        .accessibilityHidden(true)
                    Text(copy.title)
                        .font(.system(size: 30, weight: .semibold))
                    Text(copy.subtitle)
                        .font(GrokTypography.body)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 10) {
                    languageOption(
                        code: "zh-Hans",
                        title: "简体中文",
                        detail: "使用简体中文界面",
                        symbol: "globe.asia.australia"
                    )
                    languageOption(
                        code: "zh-Hant",
                        title: "繁體中文",
                        detail: "使用繁體中文介面",
                        symbol: "globe.asia.australia"
                    )
                    languageOption(
                        code: "en",
                        title: "English",
                        detail: "Use GrokDesk in English",
                        symbol: "globe.americas"
                    )
                }

                Button(copy.continueTitle) {
                    model.completeLanguageOnboarding(language: selectedLanguage)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, 48)
            .padding(.vertical, 56)
        }
        .animation(.easeInOut(duration: 0.16), value: selectedLanguage)
    }

    private func languageOption(code: String, title: String, detail: String, symbol: String) -> some View {
        Button {
            selectedLanguage = code
        } label: {
            HStack(spacing: 14) {
                Image(systemName: symbol)
                    .font(.system(size: 22, weight: .medium))
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: title)
                        .font(GrokTypography.item(.semibold))
                    Text(verbatim: detail)
                        .font(GrokTypography.metadata)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                Image(systemName: selectedLanguage == code ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(selectedLanguage == code ? Color.accentColor : Color.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
            .padding(.horizontal, 18)
            .background(Color.primary.opacity(selectedLanguage == code ? 0.075 : 0.035),
                        in: RoundedRectangle(cornerRadius: 13))
            .overlay {
                RoundedRectangle(cornerRadius: 13)
                    .stroke(selectedLanguage == code ? Color.accentColor : Color.primary.opacity(0.10),
                            lineWidth: selectedLanguage == code ? 1.5 : 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selectedLanguage == code ? .isSelected : [])
    }

    private static func suggestedLanguage() -> String {
        let preferred = Locale.preferredLanguages.first ?? ""
        let normalized = preferred.replacingOccurrences(of: "_", with: "-")
        if normalized.localizedCaseInsensitiveContains("Hant")
            || normalized.hasPrefix("zh-TW")
            || normalized.hasPrefix("zh-HK")
            || normalized.hasPrefix("zh-MO") {
            return "zh-Hant"
        }
        if normalized.hasPrefix("zh") { return "zh-Hans" }
        if normalized.hasPrefix("en") { return "en" }
        return "zh-Hans"
    }
}

private struct OnboardCopy {
    let title: String
    let subtitle: String
    let continueTitle: String

    static let simplified = OnboardCopy(
        title: "欢迎使用 GrokDesk",
        subtitle: "选择 GrokDesk 的界面语言。",
        continueTitle: "继续"
    )
    static let traditional = OnboardCopy(
        title: "歡迎使用 GrokDesk",
        subtitle: "選擇 GrokDesk 的介面語言。",
        continueTitle: "繼續"
    )
    static let english = OnboardCopy(
        title: "Welcome to GrokDesk",
        subtitle: "Choose the language used throughout the app.",
        continueTitle: "Continue"
    )
}
