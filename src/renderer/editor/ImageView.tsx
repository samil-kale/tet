import { useState } from "react";

/** Both versions as data URLs, as `FileContent` carries them. */
interface ImageSides {
  /** HEAD's. */
  before?: string;
  /** The working tree's. */
  after?: string;
}

type Side = "before" | "after";

interface Size {
  width: number;
  height: number;
}

/**
 * An image next to HEAD's (`sideBySide`) or alone. A side is absent for an added or deleted file;
 * at least one is always there.
 */
export function ImageView({ image, sideBySide }: { image: ImageSides; sideBySide: boolean }) {
  // What each side measured when it loaded, and the source that failed to decode: its box is drawn
  // at the other side's size instead.
  const [sizes, setSizes] = useState<Partial<Record<Side, Size>>>({});
  const [failed, setFailed] = useState<Partial<Record<Side, string>>>({});

  const picture = (side: Side) => {
    const src = image[side];
    if (failed[side] === src) {
      const other = sizes[side === "before" ? "after" : "before"];
      return (
        <div
          className="image-diff-missing"
          style={
            other && {
              // As wide as the other side, narrower where its height would pass the pane's.
              width: `min(${other.width}px, calc(var(--image-max-height) * ${other.width / other.height}))`,
              aspectRatio: `${other.width} / ${other.height}`,
            }
          }
        />
      );
    }
    return (
      <img
        src={src}
        alt=""
        onLoad={(event) => {
          const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
          setSizes((held) => ({ ...held, [side]: { width, height } }));
        }}
        onError={() => setFailed((held) => ({ ...held, [side]: src }))}
      />
    );
  };

  const both = sideBySide && Boolean(image.before && image.after);

  return (
    <div className="image-diff">
      <div className="image-diff-pair">
        {both ? (
          <>
            <figure>
              {picture("before")}
              <figcaption>Before</figcaption>
            </figure>
            <figure>
              {picture("after")}
              <figcaption>After</figcaption>
            </figure>
          </>
        ) : (
          <figure>{picture(image.after ? "after" : "before")}</figure>
        )}
      </div>
    </div>
  );
}
