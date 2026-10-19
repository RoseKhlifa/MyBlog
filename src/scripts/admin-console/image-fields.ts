import {
  getAdminRenderedImagePreviewSrc
} from '../../lib/admin-console/image-params';
import { ADMIN_HERO_IMAGE_UPLOAD_API_PATH } from '../../lib/admin-console/admin-api-paths';
import { createWithBase } from '../../utils/format';
import {
  formatAdminImageMetaSummary,
  getAdminImageResponseErrors,
  isRecord,
  type AdminImageClientItem
} from '../admin-shared/image-client';
import type { AdminImagePickerController, AdminImagePickerField } from '../admin-shared/image-picker';

type StatusSetter = (
  state: string,
  text: string,
  options?: { announce?: boolean }
) => void;

const base = import.meta.env.BASE_URL ?? '/';
const withBase = createWithBase(base);
const META_PREVIEW_DEBOUNCE_MS = 360;
const HERO_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const HERO_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

const getHeroUploadValidationError = (file: File): string | null => {
  if (!file.size) return '图片文件为空，请重新选择';
  if (file.size > HERO_IMAGE_MAX_BYTES) return '图片超过 12 MB，请压缩后再上传';
  if (
    (file.type && !HERO_IMAGE_MIME_TYPES.has(file.type))
    || !/\.(?:jpe?g|png|webp|avif|gif)$/i.test(file.name)
  ) {
    return '请选择 JPG、PNG、WebP、AVIF 或 GIF 图片';
  }
  return null;
};

type ThemeImageFieldConfig = {
  field: AdminImagePickerField;
  inputId: string;
  buttonSelector: string;
  pickerTitle: string;
  pickerDescription: string;
  pickerResetLabel: string;
  pickerResetStatus: string;
  pickerFallbackCurrentValue?: string;
  pickerFallbackCurrentLabel?: string;
};

type ThemeImageFieldState = {
  enabled?: boolean;
  inactivePreviewText?: string;
  inactiveMetaText?: string;
};

type ThemeImagePreviewState =
  | { kind: 'hidden' }
  | { kind: 'image'; src: string }
  | { kind: 'placeholder'; text: string };

const FIELD_CONFIGS: readonly ThemeImageFieldConfig[] = [
  {
    field: 'home.heroImageSrc',
    inputId: 'home-hero-image-src',
    buttonSelector: '[data-admin-images-open="home.heroImageSrc"]',
    pickerTitle: '更换 Hero 图片',
    pickerDescription: '',
    pickerResetLabel: '恢复默认',
    pickerResetStatus: '已恢复 Hero 默认图',
    pickerFallbackCurrentValue: 'src/assets/hero.png',
    pickerFallbackCurrentLabel: '默认图片'
  },
  {
    field: 'page.bits.defaultAuthor.avatar',
    inputId: 'page-bits-author-avatar',
    buttonSelector: '[data-admin-images-open="page.bits.defaultAuthor.avatar"]',
    pickerTitle: '更换 Bits 作者头像',
    pickerDescription: '仅列出可直接写入 page.bits.defaultAuthor.avatar 的本地 public/** 资源。',
    pickerResetLabel: '清空头像',
    pickerResetStatus: '已清空 Bits 默认头像'
  }
];

const getDefaultPreviewSrc = (previewWrap: HTMLElement | null): string | null =>
  getAdminRenderedImagePreviewSrc(
    previewWrap?.getAttribute('data-admin-images-default-preview-src') ?? '',
    base
  );

const setPreview = (
  previewWrap: HTMLElement | null,
  previewImg: HTMLImageElement | null,
  previewPlaceholder: HTMLElement | null,
  state: ThemeImagePreviewState
): void => {
  if (!(previewWrap instanceof HTMLElement)) return;

  const hidePreview = (): void => {
    previewWrap.setAttribute('data-admin-images-preview-state', 'hidden');
    previewWrap.hidden = true;
    previewImg?.removeAttribute('src');
    if (previewImg instanceof HTMLImageElement) previewImg.hidden = true;
    if (previewPlaceholder instanceof HTMLElement) {
      previewPlaceholder.textContent = '';
      previewPlaceholder.hidden = true;
    }
  };

  previewWrap.setAttribute('data-admin-images-preview-state', state.kind);

  if (state.kind === 'hidden') {
    hidePreview();
    return;
  }

  previewWrap.hidden = false;

  if (state.kind === 'image') {
    if (!(previewImg instanceof HTMLImageElement)) {
      hidePreview();
      return;
    }

    const safePreviewSrc = getAdminRenderedImagePreviewSrc(state.src, base);
    if (
      !safePreviewSrc
      || !(
        safePreviewSrc.startsWith('https://')
        || (safePreviewSrc.startsWith('/') && !safePreviewSrc.startsWith('//'))
      )
    ) {
      hidePreview();
      return;
    }

    // DOM sink 前的最后一道边界：用 URL 构造器重新解析，切断来自输入文本的污点数据流。
    // 这里与上游校验是纵深防御，也让 CodeQL js/xss-through-dom 能识别该 sanitizer。
    let reparsedPreviewSrc: string | null = null;
    try {
      if (safePreviewSrc.startsWith('https://')) {
        const parsed = new URL(safePreviewSrc);
        if (parsed.protocol === 'https:') {
          reparsedPreviewSrc = parsed.toString();
        }
      } else {
        const parsed = new URL(safePreviewSrc, window.location.origin);
        if (
          parsed.origin === window.location.origin
          && parsed.protocol === window.location.protocol
        ) {
          reparsedPreviewSrc = `${parsed.pathname}${parsed.search}`;
        }
      }
    } catch {
      reparsedPreviewSrc = null;
    }

    if (!reparsedPreviewSrc) {
      hidePreview();
      return;
    }

    previewImg.src = reparsedPreviewSrc;
    previewImg.hidden = false;
    if (previewPlaceholder instanceof HTMLElement) {
      previewPlaceholder.textContent = '';
      previewPlaceholder.hidden = true;
    }
    return;
  }

  previewImg?.removeAttribute('src');
  if (previewImg instanceof HTMLImageElement) previewImg.hidden = true;
  if (!(previewPlaceholder instanceof HTMLElement)) {
    previewWrap.hidden = true;
    return;
  }
  previewPlaceholder.textContent = state.text;
  previewPlaceholder.hidden = false;
};

const setMetaText = (metaEl: HTMLElement | null, text: string): void => {
  if (!(metaEl instanceof HTMLElement)) return;
  metaEl.textContent = text;
  metaEl.hidden = text.trim().length === 0;
};

export const createAdminThemeImageFields = ({
  root,
  picker,
  setStatus,
  getFieldState = () => ({ enabled: true })
}: {
  root: ParentNode;
  picker: AdminImagePickerController | null;
  setStatus: StatusSetter;
  getFieldState?: (field: AdminImagePickerField) => ThemeImageFieldState;
}) => {
  const bindings = FIELD_CONFIGS.map((config) => {
    const input = root.querySelector<HTMLInputElement>(`#${config.inputId}`);
    const button = root.querySelector<HTMLButtonElement>(config.buttonSelector);
    const metaEl = root.querySelector<HTMLElement>(`[data-admin-images-meta="${config.field}"]`);
    const previewWrap = root.querySelector<HTMLElement>(`[data-admin-images-preview="${config.field}"]`);
    const previewImg = root.querySelector<HTMLImageElement>(`[data-admin-images-preview-img="${config.field}"]`);
    const previewPlaceholder = root.querySelector<HTMLElement>(
      `[data-admin-images-preview-placeholder="${config.field}"]`
    );
    const isHero = config.field === 'home.heroImageSrc';
    return {
      config,
      input,
      button,
      metaEl,
      previewWrap,
      previewImg,
      previewPlaceholder,
      uploadButton: isHero ? root.querySelector<HTMLButtonElement>('[data-admin-hero-upload]') : null,
      fileInput: isHero ? root.querySelector<HTMLInputElement>('[data-admin-hero-file]') : null,
      uploadStatus: isHero ? root.querySelector<HTMLElement>('[data-admin-hero-upload-status]') : null,
      uploadBusy: false
    };
  }).filter((binding) => binding.input instanceof HTMLInputElement);

  if (!bindings.length) return null;

  const syncImageControls = (binding: typeof bindings[number]): void => {
    const disabled = binding.uploadBusy
      || getFieldState(binding.config.field).enabled === false
      || binding.input?.disabled === true;
    if (binding.button) binding.button.disabled = disabled;
    if (binding.uploadButton) {
      binding.uploadButton.disabled = disabled;
      binding.uploadButton.textContent = binding.uploadBusy ? '正在上传…' : '上传图片';
      binding.uploadButton.setAttribute('aria-busy', String(binding.uploadBusy));
    }
    if (binding.fileInput) binding.fileInput.disabled = disabled;
  };

  const updateField = async (field: AdminImagePickerField) => {
    const binding = bindings.find((item) => item.config.field === field);
    if (!binding || !(binding.input instanceof HTMLInputElement)) return;

    const state = getFieldState(field);
    const isEnabled = state.enabled !== false;
    syncImageControls(binding);

    if (!isEnabled) {
      setMetaText(binding.metaEl, state.inactiveMetaText ?? '');
      setPreview(
        binding.previewWrap,
        binding.previewImg,
        binding.previewPlaceholder,
        state.inactivePreviewText
          ? { kind: 'placeholder', text: state.inactivePreviewText }
          : { kind: 'hidden' }
      );
      return;
    }

    const value = binding.input.value.trim();
    if (!value) {
      setMetaText(binding.metaEl, '');
      const defaultPreviewSrc = getDefaultPreviewSrc(binding.previewWrap);
      setPreview(
        binding.previewWrap,
        binding.previewImg,
        binding.previewPlaceholder,
        defaultPreviewSrc ? { kind: 'image', src: defaultPreviewSrc } : { kind: 'hidden' }
      );
      return;
    }

    setPreview(
      binding.previewWrap,
      binding.previewImg,
      binding.previewPlaceholder,
      { kind: 'hidden' }
    );

    if (!picker) {
      setMetaText(binding.metaEl, '当前页面未挂载 image picker');
      return;
    }

    try {
      const meta = await picker.readMeta({
        field,
        value
      });
      if (binding.input.value.trim() !== value) return;
      if (getFieldState(field).enabled === false) return;
      setPreview(
        binding.previewWrap,
        binding.previewImg,
        binding.previewPlaceholder,
        meta.previewSrc ? { kind: 'image', src: meta.previewSrc } : { kind: 'hidden' }
      );
      setMetaText(binding.metaEl, formatAdminImageMetaSummary(meta));
    } catch (error) {
      if (binding.input.value.trim() !== value) return;
      if (getFieldState(field).enabled === false) return;
      setPreview(
        binding.previewWrap,
        binding.previewImg,
        binding.previewPlaceholder,
        { kind: 'hidden' }
      );
      setMetaText(binding.metaEl, error instanceof Error ? error.message : '路径暂时无法读取');
    }
  };

  bindings.forEach((binding) => {
    if (!(binding.input instanceof HTMLInputElement)) return;
    let metaTimer = 0;

    const clearMetaTimer = () => {
      window.clearTimeout(metaTimer);
      metaTimer = 0;
    };

    const scheduleFieldUpdate = () => {
      clearMetaTimer();
      metaTimer = window.setTimeout(() => {
        metaTimer = 0;
        void updateField(binding.config.field);
      }, META_PREVIEW_DEBOUNCE_MS);
    };

    const updateFieldNow = () => {
      clearMetaTimer();
      void updateField(binding.config.field);
    };

    const setUploadStatus = (state: string, message: string): void => {
      if (binding.uploadStatus) {
        binding.uploadStatus.dataset.state = state;
        setMetaText(binding.uploadStatus, message);
      }
      setStatus(state, message, { announce: false });
    };

    const uploadHeroImage = async (file: File): Promise<void> => {
      const input = binding.input;
      if (
        !(input instanceof HTMLInputElement)
        || binding.uploadBusy
        || input.disabled
        || getFieldState(binding.config.field).enabled === false
      ) return;

      const validationError = getHeroUploadValidationError(file);
      if (validationError) {
        setUploadStatus('warn', validationError);
        return;
      }

      binding.uploadBusy = true;
      syncImageControls(binding);
      setUploadStatus('loading', '正在上传 Hero 图片…');
      try {
        const formData = new FormData();
        formData.set('image', file);
        const response = await fetch(withBase(ADMIN_HERO_IMAGE_UPLOAD_API_PATH), {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: formData
        });
        if (response.status === 401) {
          setUploadStatus('warn', '登录已过期，请重新登录后台后上传');
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        if (
          !response.ok
          || !isRecord(payload)
          || payload.ok !== true
          || !isRecord(payload.result)
          || typeof payload.result.src !== 'string'
          || !/^src\/assets\/hero-uploads\/hero-[a-f\d]+\.(?:jpe?g|png|webp|avif|gif)$/i.test(payload.result.src)
        ) {
          const message = getAdminImageResponseErrors(payload).join('；') || 'Hero 图片上传失败，请稍后重试';
          setUploadStatus('warn', message);
          return;
        }

        input.value = payload.result.src;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        setUploadStatus('ok', '已上传，保存配置后生效');
      } catch {
        setUploadStatus('warn', 'Hero 图片上传失败，请检查网络后重试');
      } finally {
        binding.uploadBusy = false;
        syncImageControls(binding);
      }
    };

    binding.uploadButton?.addEventListener('click', () => {
      if (binding.uploadButton?.disabled || binding.uploadBusy || binding.input?.disabled) return;
      binding.fileInput?.click();
    });
    binding.fileInput?.addEventListener('change', () => {
      const file = binding.fileInput?.files?.[0];
      if (binding.fileInput) binding.fileInput.value = '';
      if (file) void uploadHeroImage(file);
    });
    if (binding.uploadButton) {
      new MutationObserver(() => syncImageControls(binding)).observe(binding.input, {
        attributes: true,
        attributeFilter: ['disabled']
      });
    }

    binding.input.addEventListener('input', () => {
      if (!binding.uploadBusy) setMetaText(binding.uploadStatus, '');
      setMetaText(binding.metaEl, '等待确认路径并读取元数据');
      setPreview(
        binding.previewWrap,
        binding.previewImg,
        binding.previewPlaceholder,
        { kind: 'hidden' }
      );
      scheduleFieldUpdate();
    });
    binding.input.addEventListener('change', () => {
      updateFieldNow();
    });

    binding.button?.addEventListener('click', () => {
      if (getFieldState(binding.config.field).enabled === false) return;
      if (!picker) {
        setStatus('warn', '当前页面未挂载 image picker');
        return;
      }

      const pickerOptions = {
        field: binding.config.field,
        title: binding.config.pickerTitle,
        description: binding.config.pickerDescription,
        query: binding.input?.value ?? '',
        currentValue: binding.input?.value ?? '',
        resetLabel: binding.config.pickerResetLabel,
        onReset: () => {
          if (!(binding.input instanceof HTMLInputElement)) return;
          if (getFieldState(binding.config.field).enabled === false) return;
          binding.input.value = '';
          binding.input.dispatchEvent(new Event('input', { bubbles: true }));
          binding.input.dispatchEvent(new Event('change', { bubbles: true }));
          setStatus('ok', binding.config.pickerResetStatus);
        },
        onSelect: (item: AdminImageClientItem) => {
          if (!(binding.input instanceof HTMLInputElement)) return;
          if (getFieldState(binding.config.field).enabled === false) return;
          binding.input.value = item.value;
          binding.input.dispatchEvent(new Event('input', { bubbles: true }));
          binding.input.dispatchEvent(new Event('change', { bubbles: true }));
          setStatus('ok', `已选择本地图片：${item.value}`);
        }
      };

      picker.open({
        ...pickerOptions,
        ...(binding.config.pickerFallbackCurrentValue
          ? {
            fallbackCurrentValue: binding.config.pickerFallbackCurrentValue,
            ...(binding.config.pickerFallbackCurrentLabel
              ? { fallbackCurrentLabel: binding.config.pickerFallbackCurrentLabel }
              : {})
          }
          : {})
      });
    });

    updateFieldNow();
  });

  return {
    refresh: (field: AdminImagePickerField) => {
      void updateField(field);
    },
    refreshAll: () => {
      bindings.forEach((binding) => {
        void updateField(binding.config.field);
      });
    }
  };
};
