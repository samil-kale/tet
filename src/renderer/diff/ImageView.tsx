import { useState } from "react";

/** Both versions as data URLs, as `FileContent` carries them. */
interface ImageSides {
  /** HEAD's. */
  before?: string;
  /** The working tree's. */
  after?: string;
}

/**
 * An image, side by side with HEAD's or laid over it. A side is absent for an added or deleted file;
 * at least one is always there.
 */
export function ImageView({ image }: { image: ImageSides }) {
  const [overlay, setOverlay] = useState(false);
  // 0 old, 100 new, between an onion skin.
  const [blend, setBlend] = useState(50);

  const both = Boolean(image.before && image.after);
  const showOverlay = both && overlay;

  return (
    <div className="image-diff">
      {both && (
        <div className="image-diff-modes">
          <button className={`image-diff-mode${overlay ? "" : " active"}`} onClick={() => setOverlay(false)}>
            Side by side
          </button>
          <button className={`image-diff-mode${overlay ? " active" : ""}`} onClick={() => setOverlay(true)}>
            Overlay
          </button>
          {showOverlay && (
            <label className="image-diff-blend">
              Before
              <input
                type="range"
                min={0}
                max={100}
                value={blend}
                onChange={(event) => setBlend(event.currentTarget.valueAsNumber)}
              />
              After
            </label>
          )}
        </div>
      )}
      {showOverlay ? (
        // Top-left, so a size change shows as uncovered area.
        <div className="image-diff-stack">
          <img src={image.before} alt="" />
          <img src={image.after} alt="" style={{ opacity: blend / 100 }} />
        </div>
      ) : (
        <div className="image-diff-pair">
          {image.before && (
            <figure>
              <img src={image.before} alt="" />
              <figcaption>Before</figcaption>
            </figure>
          )}
          {image.after && (
            <figure>
              <img src={image.after} alt="" />
              <figcaption>After</figcaption>
            </figure>
          )}
        </div>
      )}
    </div>
  );
}
