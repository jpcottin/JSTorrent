export function FAQ() {
  return (
    <section id="help" className="section">
      <div className="container">
        <h2>Help / FAQ</h2>

        <p>
          Bug reports and feature requests are welcome on the{' '}
          <a href="https://github.com/kzahel/jstorrent/issues">JSTorrent GitHub page</a>.
        </p>

        <div className="faq">
          <details className="faq-item">
            <summary>What platforms are supported?</summary>
            <div className="faq-answer">
              <p>JSTorrent runs on Windows, Mac, Linux, ChromeOS, and Android.</p>
              <ul>
                <li>
                  <strong>Desktop</strong> (Windows/Mac/Linux): Install the standalone desktop app,
                  or use the Chrome extension paired with the desktop app.
                </li>
                <li>
                  <strong>ChromeOS</strong>: Install the Android app from the Play Store, or use the
                  Chrome extension paired with the Android companion app.
                </li>
                <li>
                  <strong>Android</strong>: Install the Android app from the Play Store. It works as
                  a standalone torrent client.
                </li>
              </ul>
            </div>
          </details>

          <details className="faq-item">
            <summary>Do I need the Chrome extension?</summary>
            <div className="faq-answer">
              <p>
                No. The desktop app and Android app both work standalone without the extension. The
                extension is optional and provides browser integration (intercepting magnet links,
                right-click to add torrents, etc.).
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary>How do I add a torrent?</summary>
            <div className="faq-answer">
              <p>Find a torrent file or magnet link on the web, then either:</p>
              <ul>
                <li>Click a magnet link (JSTorrent will handle it automatically)</li>
                <li>Download a .torrent file and open it with JSTorrent</li>
                <li>Paste a magnet link or torrent URL into the app</li>
              </ul>
            </div>
          </details>

          <details className="faq-item">
            <summary>Where do the files download to?</summary>
            <div className="faq-answer">
              <p>
                On desktop, files download to your configured download folder (defaults to your
                Downloads directory). On Android, you choose a storage location when you first add a
                torrent.
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary>My torrent isn&apos;t downloading!</summary>
            <div className="faq-answer">
              <p>
                Check that you have peers available for the torrent. Some torrents have very few
                seeders and may be slow or unavailable.
              </p>
              <p>
                If you still have issues, please report them on the{' '}
                <a href="https://github.com/kzahel/jstorrent/issues">GitHub issue tracker</a>.
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary>Does this work with private trackers?</summary>
            <div className="faq-answer">
              <p>
                Yes. Download the .torrent file from your tracker&apos;s website first, then load it
                into JSTorrent. Many trackers employ a whitelist for allowed clients. Contact your
                tracker&apos;s administrators if JSTorrent is not whitelisted.
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary>How does ChromeOS work?</summary>
            <div className="faq-answer">
              <p>
                On ChromeOS, you can use the Android app from the Play Store as a standalone torrent
                client — no extension needed.
              </p>
              <p>
                Alternatively, install the Chrome extension alongside the Android companion app. The
                extension provides the UI, while the Android app handles file I/O and networking. A
                one-time pairing step connects them, and after that the extension automatically
                connects whenever you open it.
              </p>
            </div>
          </details>
        </div>
      </div>
    </section>
  )
}
