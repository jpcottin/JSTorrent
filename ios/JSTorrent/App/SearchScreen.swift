import SwiftUI
import JSTorrentKit

struct SearchScreen: View {
    @ObservedObject var controller: EngineController
    @StateObject private var viewModel: SearchViewModel
    @Environment(\.openURL) private var openURL

    init(
        controller: EngineController,
        providers: [any TorrentSearchProvider] = [InternetArchiveSearchProvider()]
    ) {
        self.controller = controller
        _viewModel = StateObject(
            wrappedValue: SearchViewModel(
                controller: controller,
                providers: providers
            )
        )
    }

    var body: some View {
        List {
            Section(L10n.string("search_title")) {
                TextField(L10n.string("search_query_label"), text: $viewModel.query, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                Picker(L10n.string("search_provider_label"), selection: providerSelection) {
                    ForEach(viewModel.providerDescriptors) { provider in
                        Text(provider.name).tag(provider.id)
                    }
                }

                Picker(L10n.string("search_category_label"), selection: categorySelection) {
                    ForEach(viewModel.availableCategories) { category in
                        Text(category.title).tag(category.id)
                    }
                }

                Button(L10n.string("search_action_button")) {
                    viewModel.runSearch()
                }
                .disabled(viewModel.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.isSearching)
            }

            if let statusMessage = viewModel.statusMessage {
                Section {
                    Text(statusMessage)
                        .foregroundStyle(.green)
                }
            }

            if let errorMessage = viewModel.errorMessage {
                Section(L10n.string("search_source_failed")) {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }

            Section(L10n.string("search_results_title")) {
                if viewModel.isSearching {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(L10n.string("search_searching"))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                } else if viewModel.results.isEmpty, viewModel.hasSearched {
                    Text(L10n.string("search_no_results"))
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 8)
                } else {
                    ForEach(viewModel.results) { result in
                        SearchResultRow(
                            result: result,
                            isAdding: viewModel.isAdding(result),
                            onAdd: {
                                viewModel.add(result)
                            },
                            onOpenDetails: result.detailsURL.map { url in
                                { openURL(url) }
                            }
                        )
                    }
                }
            }
        }
        .navigationTitle(L10n.string("search_title"))
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: ObjectIdentifier(controller)) { _ in
            viewModel.updateController(controller)
        }
    }

    private var providerSelection: Binding<String> {
        Binding(
            get: { viewModel.selectedProviderID },
            set: { viewModel.selectProvider($0) }
        )
    }

    private var categorySelection: Binding<String> {
        Binding(
            get: { viewModel.selectedCategoryID },
            set: { viewModel.selectCategory($0) }
        )
    }
}

private struct SearchResultRow: View {
    let result: TorrentSearchResult
    let isAdding: Bool
    let onAdd: () -> Void
    let onOpenDetails: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(result.name)
                .font(.headline)

            HStack(spacing: 10) {
                SearchMetadataPill(label: result.providerName, systemImage: "shippingbox")

                if let seeds = result.seeds {
                    SearchMetadataPill(label: "\(seeds)", systemImage: "person.2.fill")
                }

                if let size = result.size {
                    SearchMetadataPill(
                        label: ByteCountFormatter.string(fromByteCount: size, countStyle: .file),
                        systemImage: "internaldrive"
                    )
                }
            }

            if let publishedAt = result.publishedAt {
                Text(Self.dateFormatter.string(from: publishedAt))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Button {
                    onAdd()
                } label: {
                    if isAdding {
                        ProgressView()
                    } else {
                        Text(L10n.string("search_add_result"))
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isAdding)

                if let onOpenDetails {
                    Button(L10n.string("search_open_details")) {
                        onOpenDetails()
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()
}

private struct SearchMetadataPill: View {
    let label: String
    let systemImage: String

    var body: some View {
        Label(label, systemImage: systemImage)
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}
