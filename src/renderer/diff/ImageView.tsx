import { useState } from "react";

/** Both versions of an image as data URLs, as `FileContent` carries them. */
export interface ImageSides {
  /** What HEAD has of it. */
  before?: string;
  /** What the working tree has. */
  after?: string;
}

/**
 * A changed image, the one file the diff editor cannot show: the committed version beside the
 * current one, or the two laid over each other. Either side is absent when the file was added or
 * deleted, and both are when neither version fits in a data URL.
 */
export function ImageView({ image }: { image: ImageSides }) {
  const [overlay, setOverlay] = useState(false);
  // 0 shows the old version, 100 the new one, the middle an onion-skin overlay.
  const [blend, setBlend] = useState(50);

  if (!image.before && !image.after) {
    return <div className="placeholder">Image too large to show.</div>;
  }

  // Only a modified image has two versions to lay over each other.
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
        // Aligned top-left, so a size change reads as the images not covering each other.
        <div className="image-diff-stack">
          <img src={image.before} alt="" />
          <img src={image.after} alt="" style={{ opacity: blend / 100 }} />
        </div>
      ) : (
        // Two-up: the committed version beside the current one.
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
