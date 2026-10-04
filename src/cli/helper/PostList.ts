import { EOL } from 'os';
import Downloader from '../../downloaders/Downloader.js';
import PostsFetcher from '../../downloaders/PostsFetcher.js';
import { commonLog } from '../../utils/logging/Logger.js';
import { getCLIOptions } from '../CLIOptions.js';
import CommandLineParser from '../CommandLineParser.js';
import ConsoleLogger from '../../utils/logging/ConsoleLogger.js';
import URLHelper from '../../utils/URLHelper.js';
import { IncludeCriteriaHelper } from '../../downloaders/IncludeCriteriaHelper.js';

export type ListPostsResult = false | {
  hasError: boolean;
};

export async function listPosts(options: {
  onOptionError: (error: unknown) => Promise<void>;
}): Promise<ListPostsResult> {
  let listPostsTargets;
  try {
    listPostsTargets = CommandLineParser.listPosts();
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }
  if (listPostsTargets) {
    const { byVanity: vanities, byUserId: userIds } = listPostsTargets;
    let hasError = false;
    const options = getCLIOptions(true);
    const consoleLogger = new ConsoleLogger(options.consoleLogger);
    const warnLogger = new ConsoleLogger({
      logLevel: 'warn'
    });

    const abortController = new AbortController();
    const abortHandler = () => {
      console.log('Abort');
      abortController.abort();
    };
    process.on('SIGINT', abortHandler);

    const __doList = async (targets: string[], targetType: 'vanity' | 'userId') => {
      for (const target of targets) {
        try {
          const url = URLHelper.constructUserPostsURL(
            targetType === 'vanity' ?{ vanity: target } : { userId: target }
          );
          const downloader = await Downloader.getInstance(
            url,
            options
          );
          const PostDownloader = (await import('../../downloaders/PostDownloader.js')).default;
          if (!(downloader instanceof PostDownloader)) {
            throw Error('Type mismatch: PostDownloader expected');
          }

          const config = downloader.getConfig(false);
          const postsFetcher = new PostsFetcher({
            config,
            fetcher: downloader.getFetcher(),
            logger: warnLogger,
            signal: abortController.signal
          });
          
          console.log(`*** Posts by ${target} ***${EOL}`);
          
          postsFetcher.begin();
          let breakWhile = false;
          while (postsFetcher.hasNext()) {
            const { list, aborted, error } = await postsFetcher.next();
            if (!list || aborted) {
              break;
            }
            if (!list && error) {
              commonLog(consoleLogger, 'error', null, 'Error fetching posts:', error);
              hasError = true;
              return;
            }
            for (const post of list.items) {
              if (abortController.signal.aborted) {
                return;
              }
              const criteriaHelper = new IncludeCriteriaHelper(warnLogger);
              const criteriaCheck = criteriaHelper.checkPost(post, config);
              if (criteriaCheck.ok) {
                console.log(post.title);
                console.log(post.publishedAt);
                console.log(post.url);
                console.log('');
                continue;
              }
              if (criteriaCheck.reason === 'publishDateOutOfRange') {
                const publishedAt = post.publishedAt ? new Date(post.publishedAt).getTime() : null;
                const after = config.include.postsPublished.after?.valueOf().getTime();
                if (publishedAt && after && publishedAt < after) {
                  // All subsequent posts will be out of date range, so we can return right away.
                  breakWhile = true;
                  break;
                }
              }
            }
            if (breakWhile) {
              break;
            }
          }
        }
        catch (error) {
          commonLog(consoleLogger, 'error', null, `Error listing posts for ${target}:`, error);
          hasError = true;
        }
      }
    };

    await __doList(vanities, 'vanity');
    if (abortController.signal.aborted || hasError) {
      return { hasError };  
    }
    await __doList(userIds, 'userId');
    process.off('SIGINT', abortHandler);
    return { hasError };
  }

  return false;
}