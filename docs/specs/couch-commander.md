# Couch Commander

**Type:** Web App
**Tech Stack:** TypeScript, Node.js, Prisma, Fly.io

## Description

A web application that helps you take control of your TV watching by creating personalized viewing schedules across multiple streaming platforms and broadcast channels. Instead of endlessly scrolling through Netflix, Hulu, and cable guides wondering what to watch, Couch Commander lets you build weekly schedules based on your favorite shows, discover new content that fits your available time slots, and get reminders so you never miss episodes. Perfect for families coordinating shared viewing time or individuals who want to be more intentional about their entertainment consumption rather than falling into the infinite scroll trap.

## Use Case

i want people to be able to create a list of tv shows that they want to watch, the number of hours per day they want to watch tv (weekdays and weekends), look up the tv shows online (tvdb or imdb probably) making note of any long or multipart episodes, and make a tv schedule. 5). the idea is to move away from binge watching.

## Target Customers

- General Users

## Features

- **Show Search & Browse** - Search for TV shows and movies by title, genre, or network with basic filtering
- **Personal Schedule** - Add shows to a personal calendar view to track what's airing when
- **Episode Tracking** - Mark episodes as watched/unwatched and see next episode to watch
- **Reminder Notifications** - Get notified before your tracked shows air (email or browser notification)
- **Basic User Accounts** - Simple registration/login to save personal schedules across devices
- **the option to select if you have already started the series and where tou are at in it** - selcting whwre you are in current series
- **calander sync** - syncijg with google calendar
- **episode count** - look up number of episodes and length, noting any multipart or extra long episodes
- **tv time** - select the number of hours you want to watch each weekday as well as the weekend (days of the week can be set differently in needed)
- **content warnings** - usijg does the dog die to add quick icons to the schedule if there is any disturbing content reported on did the dog die
- **scheduler** - automatically schedule tv shows within the alotted time
- **rules** - any rules about genre that people want to add to thier schedules (comedy tiesday, no horror on the weekdays, etc
- **was it watched** - a message asking if any shows were missed so the schedule can be adjusted
- **to finish?** - do they want to watch a show from episode one to the end of the series or do they want to wacth all shows one episode at a time (default to whole series
- **staggered start** - the option to stagger show starts do show seasons don't end at the same time if they have the same number of episodes

## User Journey



## Technical Notes

- **Multi-tenant:** Yes
- **Integrations:** Github, Calendar, Database