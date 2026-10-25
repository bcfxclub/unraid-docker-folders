import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ConfirmModal from '../ConfirmModal.vue';

function mountConfirm(props: Record<string, unknown> = {}) {
  return mount(ConfirmModal, {
    props: { isOpen: true, title: 'Stack Down', message: 'Delete it?', confirmLabel: 'Go', ...props },
    global: { stubs: { Teleport: true } },
  });
}

const confirmButton = (wrapper: ReturnType<typeof mountConfirm>) =>
  wrapper.findAll('button').find((b) => b.text() === 'Go')!;

describe('ConfirmModal', () => {
  it('shows no checkbox without a checkbox label', async () => {
    const wrapper = mountConfirm();
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    await confirmButton(wrapper).trigger('click');
    expect(wrapper.emitted('confirm')).toEqual([[false]]);
  });

  it('confirms with the checkbox state', async () => {
    const wrapper = mountConfirm({ checkboxLabel: "Don't ask again" });
    expect(wrapper.text()).toContain("Don't ask again");
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await confirmButton(wrapper).trigger('click');
    expect(wrapper.emitted('confirm')).toEqual([[true]]);
  });

  it('clears the checkbox each time it opens', async () => {
    const wrapper = mountConfirm({ checkboxLabel: "Don't ask again" });
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
  });
});
