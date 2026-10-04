import { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import { type CampaignLayoutOutletContext } from "../layouts/CampaignLayout";

function CampaignHome() {
  const navigate = useNavigate();
  const { campaign } = useOutletContext<CampaignLayoutOutletContext>();
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!campaign) {
      setResolvedUrl(null);
      return;
    }
    let p = '';
    if (campaign.postCount > 0) {
      p = `posts`;
    }
    else if (campaign.productCount > 0) {
      p = 'shop';
    }
    else if (campaign.mediaCount > 0) {
      p = 'media';
    }
    else {
      p = 'about';
    }
    setResolvedUrl(`${campaign.baseUrl}/${p}`);
  }, [campaign]);
    
  useEffect(() => {
    if (resolvedUrl) {
      void (async () => {
        await navigate(resolvedUrl, { replace: true });
      })();
    }
  }, [resolvedUrl, navigate]);

  return null;
}

export default CampaignHome;
