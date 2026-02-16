export function Footer() {
  return (
    <>
      <section className="section">
        <div className="container">
          <h2>Links</h2>
          <div className="links-grid">
            <div className="links-group">
              <h3>Resources</h3>
              <ul>
                <li>
                  <a href="https://chromewebstore.google.com/detail/jstorrent/dbokmlpefliilbjldladbimlcfgbolhk">
                    Chrome Web Store
                  </a>
                </li>
                <li>
                  <a href="https://play.google.com/store/apps/details?id=com.jstorrent.app">
                    Google Play Store
                  </a>
                </li>
                <li>
                  <a href="/privacy.html">Privacy Policy</a>
                </li>
              </ul>
            </div>
            <div className="links-group">
              <h3>Development</h3>
              <ul>
                <li>
                  <a href="https://github.com/kzahel/jstorrent">Source Code</a>
                </li>
                <li>
                  <a href="https://github.com/kzahel/jstorrent/issues">Issue Tracker</a>
                </li>
                <li>
                  <a href="https://reddit.com/r/JSTorrent">JSTorrent on Reddit</a>
                </li>
              </ul>
            </div>
            <div className="links-group">
              <h3>About</h3>
              <ul>
                <li>
                  <a href="https://www.graehlarts.com/">Graehl Arts</a>
                </li>
                <li>
                  <a href="https://kyle.graehl.org">Kyle Graehl</a>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="container">
          <p>
            &copy; 2014-2026 <a href="https://www.graehlarts.com">Graehl Arts</a>
          </p>
        </div>
      </footer>
    </>
  )
}
