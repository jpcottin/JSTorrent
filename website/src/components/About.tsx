const testimonials = [
  '"It works great, it\'s easy to use."',
  '"Essential app"',
  '"Greatest app ever, it easily doubles the functionality of my chromebook. I don\'t remember it cost any money when i got it, but i would definitely pay for it. Just as good/better than a full desktop torrent client!"',
  '"I know not everyone has a chromebook and it is nice to be able to find a program that simply works, THANK YOU."',
]

export function About() {
  return (
    <section id="about" className="section">
      <div className="container">
        <h2>About JSTorrent</h2>
        <p>
          JSTorrent is a BitTorrent client that downloads torrent files with ease. It runs as a
          standalone desktop app on Windows, Mac, and Linux, as a native Android app, and as a
          Chrome extension paired with a companion app on ChromeOS. It also works on ChromeOS Flex,
          Android phones, and in any Chromium-based browser.{' '}
          <a href="#help">See all supported platforms →</a>
        </p>
        <p>
          Originally built for ChromeOS over 10 years ago, JSTorrent has been rebuilt from the
          ground up as a multi-platform, open source project.
        </p>

        <div className="rating-badge">
          <span className="stars">&#9733;</span>
          <strong>4.4</strong> (3,800+ ratings) on Chrome Web Store
        </div>

        <h3>What users say</h3>
        <div className="quotes-grid">
          {testimonials.map((quote, i) => (
            <blockquote key={i}>{quote}</blockquote>
          ))}
        </div>
      </div>
    </section>
  )
}
