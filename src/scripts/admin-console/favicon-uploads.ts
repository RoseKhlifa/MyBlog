import { ADMIN_SITE_ASSET_UPLOAD_API_PATH } from '../../lib/admin-console/admin-api-paths';
import { getAdminFaviconPreviewSrc, parseAdminFaviconUploadResult } from '../../lib/admin-console/favicon-preview';
import { createWithBase } from '../../utils/format';

type StatusSetter = (
  state: string,
  text: string,
  options?: { announce?: boolean }
) => void;

type FaviconUploadSlot = 'png' | 'appleTouchIcon';

const UPLOAD_SLOTS: readonly FaviconUploadSlot[] = ['png', 'appleTouchIcon'];
const SLOT_LABELS: Record<FaviconUploadSlot, string> = {
  png: '标签页图标',
  appleTouchIcon: '触摸图标'
};

const base = import.meta.env.BASE_URL ?? '/';
const withBase = createWithBase(base);

// 预览常显：空槽位显示主题默认图标（半透明），自定义后显示自定义图标。
const DEFAULT_PREVIEW_SRC: Record<FaviconUploadSlot, string> = {
  png: '/favicon-32x32.png',
  appleTouchIcon: '/apple-touch-icon.png'
};

/* 与 image-fields 的 DOM sink 边界一致：写入 <img src> 前用 URL 构造器重新解析同源路径。 */
const toSafePreviewSrc = (value: string): string | null => {
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || parsed.protocol !== window.location.protocol) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
};

export const createAdminFaviconUploads = ({
  root,
  inputs,
  setStatus
}: {
  root: ParentNode;
  inputs: Record<FaviconUploadSlot, HTMLInputElement>;
  setStatus: StatusSetter;
}) => {
  const endpoint = withBase(ADMIN_SITE_ASSET_UPLOAD_API_PATH);
  const busySlots = new Set<FaviconUploadSlot>();
  const previewVersions: Record<FaviconUploadSlot, number> = { png: 0, appleTouchIcon: 0 };

  const syncControls = (slot: FaviconUploadSlot): void => {
    const disabled = busySlots.has(slot) || inputs[slot].disabled;
    const uploadBtn = root.querySelector<HTMLButtonElement>(`[data-favicon-upload="${slot}"]`);
    const clearBtn = root.querySelector<HTMLButtonElement>(`[data-favicon-clear="${slot}"]`);
    const fileInput = root.querySelector<HTMLInputElement>(`[data-favicon-file="${slot}"]`);
    if (uploadBtn) {
      uploadBtn.disabled = disabled;
      uploadBtn.textContent = busySlots.has(slot) ? '正在上传…' : '上传';
      uploadBtn.setAttribute('aria-busy', String(busySlots.has(slot)));
    }
    if (clearBtn) clearBtn.disabled = disabled || !inputs[slot].value.trim();
    if (fileInput) fileInput.disabled = disabled;
  };

  const getPreviewFeedback = (slot: FaviconUploadSlot) => {
    const wrapper = root.querySelector<HTMLElement>(`[data-favicon-slot="${slot}"]`);
    if (!wrapper) return null;
    let status = wrapper.querySelector<HTMLElement>('[data-favicon-status]');
    if (!status) {
      status = document.createElement('span');
      status.className = 'admin-help';
      status.dataset.faviconStatus = slot;
      status.setAttribute('role', 'status');
      wrapper.append(status);
    }
    let retry = wrapper.querySelector<HTMLButtonElement>('[data-favicon-retry]');
    if (!retry) {
      retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'admin-btn admin-btn--ghost admin-btn--compact';
      retry.dataset.faviconRetry = slot;
      retry.textContent = '重试预览';
      retry.hidden = true;
      retry.addEventListener('click', () => {
        if (!inputs[slot].disabled && !busySlots.has(slot)) refreshPreview(slot, true);
      });
      wrapper.append(retry);
    }
    return { status, retry };
  };

  const refreshPreview = (slot: FaviconUploadSlot, retry = false): void => {
    const previewWrap = root.querySelector<HTMLElement>(`[data-favicon-preview="${slot}"]`);
    const previewImg = root.querySelector<HTMLImageElement>(`[data-favicon-preview-img="${slot}"]`);
    if (!previewWrap || !previewImg) return;

    const value = inputs[slot].value.trim();
    const previewPath = getAdminFaviconPreviewSrc(value, base);
    const safeSrc = value ? toSafePreviewSrc(previewPath === value ? withBase(value) : previewPath) : null;
    const isCustom = Boolean(safeSrc);
    let src = safeSrc ?? withBase(DEFAULT_PREVIEW_SRC[slot]);
    if (retry) src += `${src.includes('?') ? '&' : '?'}preview=${Date.now()}`;
    const version = ++previewVersions[slot];
    const feedback = getPreviewFeedback(slot);
    if (feedback) {
      feedback.status.textContent = '读取中…';
      feedback.retry.hidden = true;
    }
    previewWrap.dataset.loadState = 'loading';
    previewImg.alt = `${SLOT_LABELS[slot]}预览`;
    previewImg.onload = () => {
      if (version !== previewVersions[slot]) return;
      previewWrap.dataset.loadState = 'ready';
      if (feedback) feedback.status.textContent = '';
    };
    previewImg.onerror = () => {
      if (version !== previewVersions[slot]) return;
      previewWrap.dataset.loadState = 'error';
      const showFailure = (message: string) => {
        if (version !== previewVersions[slot]) return;
        if (feedback) {
          feedback.status.textContent = message;
          feedback.retry.hidden = false;
        }
        previewImg.alt = message;
      };
      showFailure('预览读取失败，请重试');
      // An <img> error alone does not reveal whether the login session expired.
      void fetch(src, { credentials: 'same-origin', cache: 'no-store' }).then((response) => {
        if (response.status === 401) showFailure('登录已过期，请重新登录后台');
      }).catch(() => {});
    };

    previewImg.src = src;
    previewWrap.dataset.state = isCustom ? 'custom' : 'default';
    previewWrap.title = isCustom ? value : '主题默认';
    syncControls(slot);
  };

  const applyUploadedPath = (slot: FaviconUploadSlot, nextPath: string): void => {
    const input = inputs[slot];
    input.value = nextPath;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    refreshPreview(slot);
  };

  const uploadFile = async (slot: FaviconUploadSlot, file: File): Promise<void> => {
    if (busySlots.has(slot) || inputs[slot].disabled) return;
    busySlots.add(slot);
    syncControls(slot);
    setStatus('loading', `正在上传${SLOT_LABELS[slot]}…`, { announce: false });

    try {
      const formData = new FormData();
      formData.set('slot', slot);
      formData.set('image', file);
      const response = await fetch(endpoint, {
        method: 'POST',
        body: formData
      });
      if (response.status === 401) {
        setStatus('warn', '登录已过期，请重新登录后台后再上传');
        return;
      }
      const payload: unknown = await response.json();
      const result = parseAdminFaviconUploadResult(payload, slot);

      if (!response.ok || !result) {
        const errors = payload && typeof payload === 'object' && 'errors' in payload && Array.isArray(payload.errors)
          ? payload.errors.filter((error): error is string => typeof error === 'string')
          : [];
        const message = errors.length ? errors.join('；') : '站点图标上传失败，请重试';
        setStatus('warn', message);
        return;
      }

      if (inputs[slot].disabled) {
        setStatus('warn', '图片已上传，当前表单暂不可编辑，请稍后重新选择');
        return;
      }
      applyUploadedPath(slot, result.path);
      const sizeText = `（${result.width}x${result.height}）`;
      setStatus('ok', `已上传${SLOT_LABELS[slot]}${sizeText}，保存后生效`);
    } catch {
      setStatus('warn', '站点图标上传失败，请检查连接后重试');
    } finally {
      busySlots.delete(slot);
      syncControls(slot);
    }
  };

  UPLOAD_SLOTS.forEach((slot) => {
    const input = inputs[slot];
    const uploadBtn = root.querySelector<HTMLButtonElement>(`[data-favicon-upload="${slot}"]`);
    const clearBtn = root.querySelector<HTMLButtonElement>(`[data-favicon-clear="${slot}"]`);
    const fileInput = root.querySelector<HTMLInputElement>(`[data-favicon-file="${slot}"]`);

    uploadBtn?.addEventListener('click', () => {
      if (input.disabled || busySlots.has(slot)) return;
      fileInput?.click();
    });

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) void uploadFile(slot, file);
    });

    clearBtn?.addEventListener('click', () => {
      if (input.disabled || busySlots.has(slot)) return;
      if (!input.value.trim()) return;
      applyUploadedPath(slot, '');
      setStatus('ok', `已恢复${SLOT_LABELS[slot]}为主题默认，保存后生效`);
    });

    input.addEventListener('input', () => refreshPreview(slot));
    input.addEventListener('change', () => refreshPreview(slot));
    refreshPreview(slot);
  });

  return {
    refreshAll: (): void => {
      UPLOAD_SLOTS.forEach((slot) => refreshPreview(slot));
    }
  };
};
