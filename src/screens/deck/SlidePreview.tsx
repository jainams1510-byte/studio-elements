import { BAND, boxes, CAPTION_H, CAPTION_Y, LOGO_BOX, NAME_BOX, pct, TITLE_BOX, type Slide } from '../../deck/deck'

/**
 * One slide drawn the deck's own way (beige ground, brown band, white title right-aligned, logo and
 * STUDIO / ELEMENTS lower right). Positions are percentages of a 16:9 box and type uses container
 * units, so it scales to any width. Images keep their aspect ratio inside their box (the original fit()).
 */
export default function SlidePreview({
  slide,
  urlFor,
  logoUrl,
  label,
}: {
  slide: Slide
  /** Signed URL for a slot, or null when the slot is empty or not loaded yet. */
  urlFor: (key: string) => string | null
  logoUrl: string
  label: string
}) {
  return (
    <div className="dk-pv" role="img" aria-label={label}>
      <div className="dk-pb" style={pct(BAND)} />
      <div className="dk-pt" style={pct(TITLE_BOX)}>
        <span>{slide.title}</span>
      </div>
      <img className="dk-pimg" alt="" src={logoUrl} style={pct(LOGO_BOX)} />
      <div className="dk-pl" style={pct(NAME_BOX)}>
        STUDIO
        <br />
        ELEMENTS
      </div>
      {boxes(slide).map((b) => {
        const url = urlFor(b.key)
        return (
          <div key={b.key} className="dk-slotwrap">
            {url ? (
              <img className="dk-pimg" alt="" data-slot={b.key} src={url} style={pct(b.box)} />
            ) : (
              <div className="dk-ph" style={pct(b.box)}>
                {b.key === 'kp' ? 'Add key plan' : 'Add image'}
              </div>
            )}
            {b.caption && (
              <div className="dk-pc" style={pct([b.box[0], CAPTION_Y, b.box[2], CAPTION_H])}>
                {b.caption}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
