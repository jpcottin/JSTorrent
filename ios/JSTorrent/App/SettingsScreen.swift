import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct SettingsScreen: View {
    @ObservedObject var settings: AppSettings
    @State private var isPresentingFolderPicker = false

    var body: some View {
        Form {
            Section(
                header: Text(L10n.string("settings_storage_title")),
                footer: Text(L10n.string("settings_download_folder_footer"))
            ) {
                LabeledContent(L10n.string("settings_download_folder_label")) {
                    Text(settings.downloadFolderDisplayName)
                        .multilineTextAlignment(.trailing)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(settings.downloadFolderPath)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                .padding(.vertical, 4)
            }

            Section {
                Button(L10n.string("settings_download_folder_choose_button")) {
                    isPresentingFolderPicker = true
                }

                if settings.usesExternalDownloadFolder {
                    Button(L10n.string("settings_download_folder_reset_button"), role: .destructive) {
                        settings.resetDownloadFolderToInternal()
                    }
                }
            }

            if let lastError = settings.lastError {
                Section(L10n.string("torrent_list_error")) {
                    Text(lastError)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(L10n.string("settings_title"))
        .sheet(isPresented: $isPresentingFolderPicker) {
            DownloadFolderPicker(
                isPresented: $isPresentingFolderPicker,
                onPick: { url in
                    settings.selectDownloadFolder(url)
                }
            )
        }
    }
}

private struct DownloadFolderPicker: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    let onPick: (URL) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(isPresented: $isPresented, onPick: onPick)
    }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(
            forOpeningContentTypes: [.folder],
            asCopy: false
        )
        picker.delegate = context.coordinator
        picker.allowsMultipleSelection = false
        picker.shouldShowFileExtensions = true
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        @Binding private var isPresented: Bool
        private let onPick: (URL) -> Void

        init(isPresented: Binding<Bool>, onPick: @escaping (URL) -> Void) {
            self._isPresented = isPresented
            self.onPick = onPick
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            if let url = urls.first {
                onPick(url)
            }
            isPresented = false
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            isPresented = false
        }
    }
}
