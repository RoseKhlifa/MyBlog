import { uploadAdminSiteImage } from './site-image-upload';

export {
  ADMIN_SITE_IMAGE_UPLOAD_MAX_BYTES as ADMIN_AVATAR_UPLOAD_MAX_BYTES,
  AdminSiteImageUploadError as AdminAvatarUploadError,
  type AdminSiteImageUploadResult as AdminAvatarUploadResult
} from './site-image-upload';

export const ADMIN_AVATAR_UPLOAD_DIRECTORY = 'public/author/uploads';

export const uploadAdminAvatarImage = ({ file }: { file: File }) => uploadAdminSiteImage({
  file,
  directory: ADMIN_AVATAR_UPLOAD_DIRECTORY,
  filePrefix: 'avatar',
  label: '默认头像'
});
