import type { Campaign, Post, Product } from "../../../entities";
import { ProductType } from "../../../entities/Product";

export function getCampaignBaseUrl(campaign: Campaign) {
  return campaign.creator?.vanity ?
    `/${encodeURIComponent(campaign.creator.vanity)}` :
    `/campaigns/${campaign.id}`;
}

export function getContentUrl(entity: Post | Product) {
  let domain, referenceId;
  switch (entity.type) {
    case 'post':
      domain = 'posts';
      referenceId = entity.id;
      break;
    case 'product': {
      if (entity.productType === ProductType.Post) {
        domain = 'posts';
        referenceId = entity.referencedEntityId;
      }
      else if (entity.productType === ProductType.Collection) {
        domain = 'collections';
        referenceId = entity.referencedEntityId;
      }
      else {
        domain = 'products';
        referenceId = entity.id;
      }
      break;
    }
  } 
  const originalFilename = entity.url ? entity.url.split('/').pop() : null;
  // Check if the url ends with <slug>-<id>
  if (originalFilename && originalFilename.split('-').pop() === referenceId) {
    return `/${domain}/${originalFilename}`;
  }
  return `/${domain}/${referenceId}`;
}