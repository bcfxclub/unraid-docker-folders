import { describe, it, expect, afterEach } from 'vitest';
import { defineComponent, h, ref, nextTick, Teleport } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createDropRevert } from '../dropRevert';

// Two roots, like ContainerCard: Vue keeps anchors around the card.
const Card = defineComponent({
  props: { name: { type: String, required: true } },
  setup: (props) => () => [h('div', { class: 'card', 'data-name': props.name }, props.name), h(Teleport, { to: 'body' }, [])],
});

describe('createDropRevert', () => {
  let wrapper: VueWrapper | undefined;
  afterEach(() => {
    wrapper?.unmount();
    document.body.innerHTML = '';
  });

  it('lets Vue remove a card dropped into another list', async () => {
    const names = ref(['a', 'b', 'c']);
    wrapper = mount(
      defineComponent({ setup: () => () => h('div', names.value.map((n) => h(Card, { key: n, name: n }))) }),
      { attachTo: document.body },
    );
    const from = wrapper.element;
    const item = from.querySelector('[data-name="a"]')!;
    const target = document.body.appendChild(document.createElement('div'));
    const drop = createDropRevert();

    drop.remember(item);
    target.appendChild(item);
    drop.revert(from, item);
    names.value = ['b', 'c'];
    await nextTick();

    const shown = Array.from(document.querySelectorAll('.card')).map((e) => e.getAttribute('data-name'));
    expect(shown).toEqual(['b', 'c']);
  });

  it('lets Vue reorder a card moved within its own list, and remove it later', async () => {
    const names = ref(['a', 'b', 'c']);
    wrapper = mount(
      defineComponent({ setup: () => () => h('div', names.value.map((n) => h(Card, { key: n, name: n }))) }),
      { attachTo: document.body },
    );
    const list = wrapper.element;
    const item = list.querySelector('[data-name="a"]')!;
    const drop = createDropRevert();

    drop.remember(item);
    list.insertBefore(item, list.querySelector('[data-name="c"]'));
    drop.revert(list, item);
    names.value = ['b', 'a', 'c'];
    await nextTick();
    const order = () => Array.from(document.querySelectorAll('.card')).map((e) => e.getAttribute('data-name'));
    expect(order()).toEqual(['b', 'a', 'c']);

    names.value = ['b', 'c'];
    await nextTick();
    expect(order()).toEqual(['b', 'c']);
  });
});
