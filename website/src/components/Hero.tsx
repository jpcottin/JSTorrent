function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent)
}

export function Hero() {
  return (
    <section className="hero">
      <div className="container">
        <img src="/cook/JSTorrent/js-256.png" alt="JSTorrent Logo" className="hero-logo" />
        <div className="hero-content">
          <h1>
            <strong>JSTorrent</strong>
          </h1>
          <h2>The torrent client that runs on any device</h2>
          <p className="description">
            One engine, every platform. Fast, free, and{' '}
            <a href="https://github.com/kzahel/jstorrent">open source</a>.
          </p>
          <a href={isAndroid() ? '#download-android' : '#download'} className="btn btn-primary btn-large">
            Download
          </a>
        </div>
      </div>
    </section>
  )
}
