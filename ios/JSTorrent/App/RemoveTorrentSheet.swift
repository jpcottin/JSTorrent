import SwiftUI
import JSTorrentKit

struct RemoveTorrentSheet: View {
    let torrent: TorrentListItem
    let onConfirm: (Bool) -> Void
    let onCancel: () -> Void

    @State private var deleteFiles = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(torrentDisplayName(torrent))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Section {
                    Toggle(isOn: $deleteFiles) {
                        Text(L10n.string("dialog_remove_delete_files_label"))
                    }
                }
            }
            .navigationTitle(L10n.string("dialog_remove_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("dialog_remove_cancel_button")) {
                        onCancel()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("dialog_remove_confirm_button"), role: .destructive) {
                        onConfirm(deleteFiles)
                    }
                }
            }
        }
        .presentationDetents([.height(220)])
    }
}
