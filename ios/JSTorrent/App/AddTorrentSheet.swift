import SwiftUI
import UIKit

struct AddTorrentSheet: View {
    @Binding var magnetInput: String
    let onAdd: () -> Void
    let onBrowse: () -> Void
    let onAddTestTorrent: () -> Void

    @Environment(\.dismiss) private var dismiss

    private var canAddMagnet: Bool {
        !magnetInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var clipboardText: String? {
        let candidate = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let candidate, !candidate.isEmpty else {
            return nil
        }

        return candidate
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(L10n.string("dialog_add_torrent_magnet_label")) {
                    TextField(L10n.string("dialog_add_torrent_magnet_hint"), text: $magnetInput, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button(L10n.string("dialog_add_torrent_paste_button")) {
                        magnetInput = clipboardText ?? magnetInput
                    }
                    .disabled(clipboardText == nil)
                }

                Section {
                    Button(L10n.string("dialog_add_torrent_add_button")) {
                        onAdd()
                        dismiss()
                    }
                    .disabled(!canAddMagnet)

                    Button(L10n.string("dialog_add_torrent_browse_button")) {
                        dismiss()
                        onBrowse()
                    }

                    Button(L10n.string("ios_add_test_torrent")) {
                        onAddTestTorrent()
                        dismiss()
                    }
                }
            }
            .navigationTitle(L10n.string("dialog_add_torrent_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("dialog_add_torrent_cancel_button")) {
                        dismiss()
                    }
                }
            }
        }
    }
}
