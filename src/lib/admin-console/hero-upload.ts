import { uploadAdminSiteImage } from './site-image-upload';

export {
  ADMIN_SITE_IMAGE_UPLOAD_MAX_BYTES as ADMIN_HERO_UPLOAD_MAX_BYTES,
  AdminSiteImageUploadError as AdminHeroUploadError,
  type AdminSiteImageUploadResult as AdminHeroUploadResult
} from './site-image-upload';

export const ADMIN_HERO_UPLOAD_DIRECTORY = 'src/assets/hero-uploads';

export const uploadAdminHeroImage = ({ file }: { file: File }) => uploadAdminSiteImage({
  file,
  directory: ADMIN_HERO_UPLOAD_DIRECTORY,
  filePrefix: 'hero',
  label: 'Hero 图片'
});
