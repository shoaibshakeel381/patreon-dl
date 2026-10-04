export interface BrowseTheme {
  name: string;
  value: string;
  stylesheets: string[];
}

export type MaxContentWidth = 'Narrower' | 'Standard' | 'Wider';

export interface BrowseSettings {
  theme: string;
  listItemsPerPage: number;
  galleryItemsPerPage: number;
  maxContentWidth: MaxContentWidth;
}

export interface BrowseSettingOptions {
  themes: BrowseTheme[];
  listItemsPerPage: number[];
  galleryItemsPerPage: number[];
  maxContentWidth: MaxContentWidth[];
}