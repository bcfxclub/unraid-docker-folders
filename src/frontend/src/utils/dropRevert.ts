/**
 * Puts a card that SortableJS dropped into another list back where it came
 * from, so Vue alone moves it.
 *
 * A ContainerCard renders two roots, its card and a Teleport, so Vue keeps
 * anchor nodes around the card and removes it by walking from one anchor to
 * the other. SortableJS moves only the card element. The card goes back next
 * to its own anchors: put before the next card instead, it lands inside that
 * card's anchors, and Vue then leaves it on the page when it removes it.
 */
export function createDropRevert() {
  let originNext: Node | null = null;
  return {
    /** Call on drag start, while the card is still in place. */
    remember(item: Node) {
      originNext = item.nextSibling;
    },
    revert(from: Node, item: Node) {
      const next = originNext && originNext.parentNode === from ? originNext : null;
      from.insertBefore(item, next);
      originNext = null;
    },
  };
}
