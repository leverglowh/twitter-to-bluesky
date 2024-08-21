import * as dotenv from 'dotenv';
import { https } from 'follow-redirects';
import FS from 'fs';
import * as process from 'process';
import URI from 'urijs';

import { BskyAgent, RichText } from '@atproto/api';

dotenv.config();



const agent = new BskyAgent({
    service: 'https://bsky.social',
})

const SIMULATE = process.env.SIMULATE === "1";

const API_DELAY = 2500; // https://docs.bsky.app/docs/advanced-guides/rate-limits

const PAST_HANDLES = process.env.TWITTER_HANDLE?.split(",");

let MIN_DATE: Date | undefined = undefined;
if (process.env.MIN_DATE != null && process.env.MIN_DATE.length > 0)
    MIN_DATE = new Date(process.env.MIN_DATE as string);

let MAX_DATE: Date | undefined = undefined;
if (process.env.MAX_DATE != null && process.env.MAX_DATE.length > 0)
    MAX_DATE = new Date(process.env.MAX_DATE as string);

function getRecord(repo, collection, rkey) {
    return new Promise((resolve, reject) => {
        let options = {
            method: 'GET',
            hostname: 'public.api.bsky.app',
            path: `/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${collection}&rkey=${rkey}`,
            headers: {
                Accept: 'application/json'
            },
            maxRedirects: 20
        };
  
      const req = https.request(options, (res) => {
        let chunks = [] as any[];
  
        res.on('data', (chunk) => {
            chunks.push(chunk);
        });
  
        res.on('end', () => {
            let body = Buffer.concat(chunks);
            resolve(JSON.parse(body.toString()));
        });
  
        res.on('error', (error) => {
            reject(error);
        });
      });
  
      req.end();
    });
}
  
async function getReplyRefs(parentUri) {
    try {
        // Parse the parent URI
        const [, , repo, collection, rkey] = parentUri.split('/');

        // Fetch the parent record
        const parent = await getRecord(repo, collection, rkey) as any;

        let root;
        if (parent.value.reply) {
            const rootUri = parent.value.reply.root.uri;
            const [, , rootRepo, rootCollection, rootRkey] = rootUri.split('/');
            root = await getRecord(rootRepo, rootCollection, rootRkey);
        } else {
            // The parent record is a top-level post, so it is also the root
            root = parent;
        }

        return {
            root: {
                uri: root.uri,
                cid: root.cid,
            },
            parent: {
                uri: parent.uri,
                cid: parent.cid,
            },
        };
    } catch (error) {
        console.error('Error fetching reply refs:', error);
        throw error;
    }
}

async function resolveShorURL(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        https.get(url, response => {
            resolve(response.responseUrl);
        }).on('error', err => {
            console.warn(`Error parsing url ${url}`);
            resolve(url);
        });
    });
}

async function cleanTweetText(tweetFullText: string): Promise<string> {
    let newText = tweetFullText;
    const urls: string[] = [];
    URI.withinString(tweetFullText, (url, start, end, source) => {
        urls.push(url);
        return url;
    });

    if (urls.length > 0) {
        const newUrls: string[] = [];
        for (let index = 0; index < urls.length; index++) {
            const newUrl = await resolveShorURL(urls[index]);
            newUrls.push(newUrl);
        }

        if (newUrls.length > 0) {
            let j = 0;
            newText = URI.withinString(tweetFullText, (url, start, end, source) => {
                // I exclude links to photos, because they have already been inserted into the Bluesky post independently
                if ((PAST_HANDLES || []).some(handle => newUrls[j].startsWith(`https://x.com/${handle}/`))
                    && newUrls[j].indexOf("/photo/") > 0) {
                    j++;
                    return "";
                }
                else
                    return newUrls[j++];
            });
        }
    }

    return newText;
}

async function main() {
    console.log(`Import started at ${new Date().toISOString()}`)
    console.log(`SIMULATE is ${SIMULATE ? "ON" : "OFF"}`);

    const fTweets = FS.readFileSync(process.env.ARCHIVE_FOLDER + "/data/tweets.js");

    const tweets = JSON.parse(fTweets.toString().replace("window.YTD.tweets.part0 = [", "["));
    let importedTweet = 0;
    let importedTweetMap = [] as Record<string, string>[];
    if (tweets != null && tweets.length > 0) {
        const sortedTweets = tweets.sort((a, b) => {
            let ad = new Date(a.tweet.created_at).getTime();
            let bd = new Date(b.tweet.created_at).getTime();
            return ad - bd;
        });

        await agent.login({ identifier: process.env.BLUESKY_USERNAME!, password: process.env.BLUESKY_PASSWORD! })

        for (let index = 0; index < sortedTweets.length; index++) {
            const tweet = sortedTweets[index].tweet;
            const tweetDate = new Date(tweet.created_at);
            const tweet_createdAt = tweetDate.toISOString();

            //this cheks assume that the array is sorted by date (first the oldest)
            if (MIN_DATE != undefined && tweetDate < MIN_DATE)
                continue;
            if (MAX_DATE != undefined && tweetDate > MAX_DATE)
                break;

            // if (tweet.id != "1237000612639846402")
            //     continue;

            console.log(`Parse tweet id '${tweet.id}'`);
            console.log(` Created at ${tweet_createdAt}`);
            console.log(` Full text '${tweet.full_text}'`);

            let postText = tweet.full_text as string;

            let reply = null as any;

            if (tweet.in_reply_to_screen_name) {
                if (PAST_HANDLES?.includes(tweet.in_reply_to_screen_name)) {
                    // Find parent and root uris to create reply refs
                    // If the parent tweet is not found or root uri request not successful, skip this tweet
                    console.log("Reply to own tweet");
                    if (!SIMULATE) {
                        const parentTweetId = tweet.in_reply_to_status_id_str;
                        const parentBlueskyUri = importedTweetMap.find((x) => x.tweetId === parentTweetId)?.blueskyPostUri;
                        if (parentBlueskyUri) {
                            try {
                                await new Promise(resolve => setTimeout(resolve, API_DELAY));
                                reply = await getReplyRefs(parentBlueskyUri);
                            } catch (error) {
                                console.error('Error fetching reply refs:', error);
                                continue;
                            }
                        } else {
                            console.log("Parent not found, skipping tweet");
                            continue;
                        }
                    }
                } else {
                    console.log("Discarded (reply to other user)");
                    continue;
                }
            }
            if (tweet.full_text.startsWith("@")) {
                console.log("Discarded (start with @)");
                continue;
            }
            if (tweet.full_text.startsWith("RT ")) {
                console.log("Discarded (start with RT)");
                continue;
            }

            let tweetWithEmbeddedVideo = false;
            let embeddedImage = [] as any;
            if (tweet.extended_entities?.media) {

                for (let index = 0; index < tweet.extended_entities.media.length; index++) {
                    const media = tweet.extended_entities.media[index];

                    if (media?.type === "photo") {
                        const i = media?.media_url.lastIndexOf("/");
                        const it = media?.media_url.lastIndexOf(".");
                        const fileType = media?.media_url.substring(it + 1)
                        let mimeType = "";
                        switch (fileType) {
                            case "png":
                                mimeType = "image/png"
                                break;
                            case "jpg":
                                mimeType = "image/jpeg"
                                break;
                            default:
                                console.error("Unsopported photo file type" + fileType);
                                break;
                        }
                        if (mimeType.length <= 0)
                            continue;

                        const mediaFilename = `${process.env.ARCHIVE_FOLDER}/data/tweets_media/${tweet.id}-${media?.media_url.substring(i + 1)}`;
                        const imageBuffer = FS.readFileSync(mediaFilename);

                        // remove media url from post text
                        postText.replace(media?.url, "");

                        if (!SIMULATE) {
                            const blobRecord = await agent.uploadBlob(imageBuffer, {
                                encoding: mimeType
                            });

                            embeddedImage.push({
                                alt: "",
                                image: {
                                    $type: "blob",
                                    ref: blobRecord.data.blob.ref,
                                    mimeType: mimeType,
                                    size: blobRecord.data.blob.size
                                }
                            })
                        }
                    }

                    if (media?.type === "video" || media?.type === "animated_gif") {
                        tweetWithEmbeddedVideo = true;
                        continue;
                    }
                }
            }

            if (tweetWithEmbeddedVideo) {
                console.log("Discarded (containnig videos)");
                continue;
            }

            if (!SIMULATE) {
                postText = await cleanTweetText(tweet.full_text);

                // if(postText.length > 300)
                //     postText = tweet.full_text;

                if( postText.length > 300)
                    postText = postText.substring(0,296) + '...';
    
                if (tweet.full_text != postText)
                    console.log(` Clean text '${postText}'`);
            }

            const rt = new RichText({
                text: postText
            });
            await rt.detectFacets(agent);
            const postRecord = {
                $type: 'app.bsky.feed.post',
                text: rt.text,
                facets: rt.facets,
                createdAt: tweet_createdAt,
                embed: embeddedImage.length > 0 ? { $type: "app.bsky.embed.images", images: embeddedImage } : undefined,
            } as any;
            if (reply) {
                postRecord.reply = reply
            }

            if (!SIMULATE) {
                //I wait 3 seconds so as not to exceed the api rate limits
                await new Promise(resolve => setTimeout(resolve, API_DELAY));

                const recordData = await agent.post(postRecord);
                const i = recordData.uri.lastIndexOf("/");
                if (i > 0) {
                    // const rkey = recordData.uri.substring(i + 1);
                    // const postUri = `https://bsky.app/profile/${process.env.BLUESKY_USERNAME!}/post/${rkey}`;
                    // console.log("Bluesky post create, URL: " + postUri);
                    importedTweet++;
                    importedTweetMap.push({ tweetId: tweet.id, blueskyPostUri: recordData.uri });
                    console.log(`blueskyPostUri: '${recordData.uri}'`);
                } else {
                    console.warn(recordData);
                }
            } else {
                importedTweet++;
            }
        }
    }

    if (SIMULATE) {
        // In addition to the delay in AT Proto API calls, we will also consider a 5% delta for URL resolution calls
        const minutes = Math.round((importedTweet * API_DELAY / 1000) / 60) + (1 / 0.1);
        const hours = Math.floor(minutes / 60);
        const min = minutes % 60;
        console.log(`Estimated time for real import: ${hours} hours and ${min} minutes`);
    }

    console.log(`Import finished at ${new Date().toISOString()}, imported ${importedTweet} tweets`)
}

main();
